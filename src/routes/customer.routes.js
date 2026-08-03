// File location: src/routes/customer.routes.js

const express = require("express");
const router = express.Router();
const pool = require("../config/db");
const crypto = require("crypto");
const { verifyLogin, requireRole } = require("../middleware/auth");
const { getTransactionRiskScore } = require("../services/mlService");

// Protect all customer routes
router.use(verifyLogin);
router.use(requireRole(["customer"]));

// Helper function to generate a cryptographically secure 10-character Txn ID
function generateTxnId() {
  const randomHex = crypto.randomBytes(5).toString("hex").toUpperCase();
  return `TXN-${randomHex}`; // Outputs e.g. TXN-8F2B1C9E4A
}

// GET /customer/balance
router.get("/balance", async (req, res) => {
  const userId = req.session.user.id;
  try {
    const result = await pool.query(
      "SELECT balance FROM customers WHERE id = $1",
      [userId],
    );
    if (result.rowCount === 0) {
      return res.status(404).send("User not found");
    }
    const balance = result.rows[0].balance;
    res.json({ balance });
  } catch (error) {
    console.error("Error fetching balance:", error);
    res.status(500).send("Server error");
  }
});

// POST /customer/sendMoney
router.post("/sendMoney", async (req, res) => {
  const senderId = req.session.user.id;
  const senderUsername = req.session.user.username;
  const { recipient, amount, category } = req.body;

  const amountNum = parseFloat(amount);
  const txnCategory = category || "Transfer";

  if (!recipient || isNaN(amountNum) || amountNum <= 0) {
    return res.status(400).send("Invalid input");
  }
  if (recipient === senderUsername) {
    return res.status(400).send("Cannot send money to yourself");
  }

  try {
    await pool.query("BEGIN");

    // 1. Lock sender record and verify funds
    const senderResult = await pool.query(
      "SELECT balance FROM customers WHERE id = $1 FOR UPDATE",
      [senderId],
    );
    if (senderResult.rowCount === 0) {
      await pool.query("ROLLBACK");
      return res.status(404).send("Sender not found");
    }

    const senderBalance = parseFloat(senderResult.rows[0].balance);
    if (senderBalance < amountNum) {
      await pool.query("ROLLBACK");
      return res.status(400).send("Insufficient funds");
    }

    // 2. Lock and fetch recipient details for verification status
    const recipientResult = await pool.query(
      "SELECT id, balance, two_factor_enabled FROM customers WHERE username = $1 FOR UPDATE",
      [recipient],
    );
    if (recipientResult.rowCount === 0) {
      await pool.query("ROLLBACK");
      return res.status(404).send("Recipient not found");
    }

    const isVerified = recipientResult.rows[0].two_factor_enabled ? 1 : 0;

    // 3. Extract dynamic features for ML Engine
    const currentHour = new Date().getHours();

    // Velocity check: count sender transactions in last 10 mins
    const recentTxnResult = await pool.query(
      `SELECT COUNT(*) FROM transactions 
       WHERE sender = $1 AND timestamp >= NOW() - INTERVAL '10 minutes'`,
      [senderUsername],
    );
    const recentCount = parseInt(recentTxnResult.rows[0].count, 10);

    // 4. Call FastAPI ML Microservice
    let mlResult;
    try {
      mlResult = await getTransactionRiskScore({
        amount: amountNum,
        hour: currentHour,
        recentCount,
        isVerified,
      });
    } catch (mlErr) {
      await pool.query("ROLLBACK");
      return res
        .status(503)
        .send(
          "Bank security servers are currently busy. Please try again in a few moments.",
        );
    }

    const riskScore = mlResult.risk_score;
    // Decision is driven 100% by the ML model score threshold
    const isHighRisk = riskScore >= 60;
    const txnId = generateTxnId();

    if (isHighRisk) {
      // Hold sender's balance and flag transaction for Employee Audit
      const newSenderBalance = senderBalance - amountNum;
      await pool.query("UPDATE customers SET balance = $1 WHERE id = $2", [
        newSenderBalance,
        senderId,
      ]);

      await pool.query(
        `INSERT INTO transactions 
         (txn_id, sender, receiver, amount, category, risk_score, is_verified_merchant, status, timestamp) 
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
        [
          txnId,
          senderUsername,
          recipient,
          amountNum,
          txnCategory,
          riskScore,
          isVerified === 1,
          "PENDING_REVIEW",
        ],
      );

      await pool.query("COMMIT");
      return res.send(
        "Transaction flagged for employee review due to unusual security risk",
      );
    } else {
      // Instant execution for approved low-risk transfers
      const newSenderBalance = senderBalance - amountNum;
      await pool.query("UPDATE customers SET balance = $1 WHERE id = $2", [
        newSenderBalance,
        senderId,
      ]);

      const recipientBalance = parseFloat(recipientResult.rows[0].balance);
      const newRecipientBalance = recipientBalance + amountNum;
      await pool.query("UPDATE customers SET balance = $1 WHERE id = $2", [
        newRecipientBalance,
        recipientResult.rows[0].id,
      ]);

      await pool.query(
        `INSERT INTO transactions 
         (txn_id, sender, receiver, amount, category, risk_score, is_verified_merchant, status, timestamp) 
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
        [
          txnId,
          senderUsername,
          recipient,
          amountNum,
          txnCategory,
          riskScore,
          isVerified === 1,
          "APPROVED",
        ],
      );

      await pool.query("COMMIT");
      return res.send("success");
    }
  } catch (error) {
    await pool.query("ROLLBACK");
    console.error("Error during sendMoney:", error);
    res.status(500).send("Server error");
  }
});

// GET /customer/transactions
router.get("/transactions", async (req, res) => {
  const currentUser = req.session.user.username;
  try {
    const result = await pool.query(
      "SELECT * FROM transactions WHERE sender = $1 OR receiver = $1 ORDER BY timestamp DESC",
      [currentUser],
    );

    const transactions = result.rows
      .filter((txn) => {
        if (
          (txn.status === "PENDING" || txn.status === "PENDING_REVIEW") &&
          txn.receiver === currentUser
        ) {
          return false;
        }
        return true;
      })
      .map((txn) => {
        let type, name;
        if (txn.sender === currentUser) {
          if (txn.status === "PENDING" || txn.status === "PENDING_REVIEW")
            type = "Pending";
          else if (txn.status === "REVERSED") type = "Reversed";
          else if (txn.status === "REJECTED") type = "Rejected";
          else type = "Debit";
          name = txn.receiver;
        } else if (txn.receiver === currentUser) {
          if (txn.status === "REJECTED") type = "Rejected";
          else type = "Credit";
          name = txn.sender;
        }
        const dateObj = new Date(txn.timestamp);
        return {
          txn_id: txn.txn_id,
          name,
          dateTime:
            dateObj.toLocaleDateString("en-GB") +
            " " +
            dateObj.toLocaleTimeString(),
          type,
          amount: txn.amount,
          status: txn.status,
          category: txn.category,
        };
      });

    res.json(transactions);
  } catch (error) {
    console.error("Error fetching transactions:", error);
    res.status(500).send("Server error");
  }
});

// POST /customer/applyLoan
router.post("/applyLoan", async (req, res) => {
  const applier = req.session.user.username;
  const { loan_type, amount, message } = req.body;

  if (!loan_type || isNaN(amount) || amount <= 0) {
    return res.status(400).send("Invalid input");
  }

  try {
    const randomHex = crypto.randomBytes(4).toString("hex").toUpperCase();
    const loan_id = `LOAN-${randomHex}`;

    await pool.query(
      "INSERT INTO loans (loan_id, loan_type, amount, status, approver, applier, message, applied_timestamp, approval_timestamp) VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP, NULL)",
      [loan_id, loan_type, amount, "PENDING", null, applier, message],
    );
    res.send("Loan application submitted successfully");
  } catch (error) {
    console.error("Error applying for loan:", error);
    res.status(500).send("Server error");
  }
});

// GET /customer/loans
router.get("/loans", async (req, res) => {
  const applier = req.session.user.username;
  try {
    const result = await pool.query(
      "SELECT * FROM loans WHERE applier = $1 ORDER BY applied_timestamp DESC",
      [applier],
    );
    res.json(result.rows);
  } catch (error) {
    console.error("Error fetching loans:", error);
    res.status(500).send("Server error");
  }
});

// POST /customer/complaint
router.post("/complaint", async (req, res) => {
  const applier = req.session.user.username;
  const { c_message } = req.body;
  if (!c_message || c_message.trim() === "") {
    return res.status(400).send("Complaint message is required");
  }
  try {
    await pool.query(
      "INSERT INTO customer_complaints (applier, c_message) VALUES ($1, $2)",
      [applier, c_message],
    );
    res.send("Complaint filed successfully");
  } catch (error) {
    console.error("Error filing complaint:", error);
    res.status(500).send("Server error");
  }
});

// GET /customer/complaints
router.get("/complaints", async (req, res) => {
  const applier = req.session.user.username;
  try {
    const result = await pool.query(
      "SELECT * FROM customer_complaints WHERE applier = $1 ORDER BY applied_timestamp DESC",
      [applier],
    );
    res.json(result.rows);
  } catch (error) {
    console.error("Error fetching customer complaints:", error);
    res.status(500).send("Server error");
  }
});

// GET /customer/me
router.get("/me", async (req, res) => {
  if (!req.session || !req.session.user) {
    return res.status(401).send("Unauthorized");
  }

  const { id, username, userType } = req.session.user;

  try {
    const result = await pool.query(
      "SELECT two_factor_enabled FROM customers WHERE id = $1",
      [id],
    );

    const is2faEnabled =
      result.rowCount > 0 ? Boolean(result.rows[0].two_factor_enabled) : false;

    return res.status(200).json({
      id,
      username,
      userType,
      twoFactorEnabled: is2faEnabled,
    });
  } catch (error) {
    console.error("Error fetching user profile:", error);
    return res.status(500).send("Server error");
  }
});

module.exports = router;
