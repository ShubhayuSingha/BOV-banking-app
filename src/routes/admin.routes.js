// File location: src/routes/admin.routes.js

const express = require("express");
const router = express.Router();
const pool = require("../config/db");
const { verifyLogin, requireRole } = require("../middleware/auth");

// Protect all admin endpoints
router.use(verifyLogin);
router.use(requireRole(["admin"]));

// POST /admin/answerComplaint (Stub from old app.js)
router.post("/answerComplaint", (req, res) => {
  res.send("Employee complaints answered (stub).");
});

// POST /admin/reverseTransaction
router.post("/reverseTransaction", async (req, res) => {
  const { txn_id } = req.body;
  if (!txn_id) return res.status(400).send("Transaction ID required.");

  try {
    await pool.query("BEGIN");
    const txnResult = await pool.query(
      "SELECT * FROM transactions WHERE txn_id = $1 FOR UPDATE",
      [txn_id],
    );
    if (txnResult.rowCount === 0) {
      await pool.query("ROLLBACK");
      return res.status(404).send("Transaction not found");
    }
    const txn = txnResult.rows[0];
    if (txn.status === "REVERSED") {
      await pool.query("ROLLBACK");
      return res.status(400).send("Transaction already reversed");
    }
    if (txn.status !== "APPROVED") {
      await pool.query("ROLLBACK");
      return res.status(400).send("Only approved transactions can be reversed");
    }

    const senderResult = await pool.query(
      "SELECT id, balance FROM customers WHERE username = $1 FOR UPDATE",
      [txn.sender],
    );
    const receiverResult = await pool.query(
      "SELECT id, balance FROM customers WHERE username = $1 FOR UPDATE",
      [txn.receiver],
    );

    if (senderResult.rowCount === 0 || receiverResult.rowCount === 0) {
      await pool.query("ROLLBACK");
      return res.status(404).send("Sender or receiver not found");
    }

    const senderBalance = parseFloat(senderResult.rows[0].balance);
    const receiverBalance = parseFloat(receiverResult.rows[0].balance);
    const amount = parseFloat(txn.amount);

    if (receiverBalance < amount) {
      await pool.query("ROLLBACK");
      return res
        .status(400)
        .send(
          "Receiver does not have sufficient funds to reverse the transaction",
        );
    }

    const newSenderBalance = senderBalance + amount;
    const newReceiverBalance = receiverBalance - amount;

    await pool.query("UPDATE customers SET balance = $1 WHERE id = $2", [
      newSenderBalance,
      senderResult.rows[0].id,
    ]);
    await pool.query("UPDATE customers SET balance = $1 WHERE id = $2", [
      newReceiverBalance,
      receiverResult.rows[0].id,
    ]);
    await pool.query("UPDATE transactions SET status = $1 WHERE txn_id = $2", [
      "REVERSED",
      txn_id,
    ]);

    await pool.query("COMMIT");
    res.send("Transaction reversed successfully");
  } catch (error) {
    await pool.query("ROLLBACK");
    console.error("Error reversing transaction:", error);
    res.status(500).send("Server error");
  }
});

// GET /admin/employeeComplaints
router.get("/employeeComplaints", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM employee_complaints ORDER BY applied_timestamp DESC",
    );
    res.json(result.rows);
  } catch (error) {
    console.error("Error fetching employee complaints for admin:", error);
    res.status(500).send("Server error");
  }
});

// POST /admin/resolveEmployeeComplaint
router.post("/admin/resolveEmployeeComplaint", async (req, res) => {
  const resolver = req.session.user.username;
  const { ecomp_id, a_message } = req.body;
  if (!ecomp_id || !a_message || a_message.trim() === "") {
    return res
      .status(400)
      .send("Complaint ID and resolution message are required");
  }
  try {
    const result = await pool.query(
      "UPDATE employee_complaints SET status = 'resolved', resolver = $1, a_message = $2, resolved_timestamp = CURRENT_TIMESTAMP WHERE ecomp_id = $3 AND status = 'unresolved'",
      [resolver, a_message, ecomp_id],
    );
    if (result.rowCount === 0)
      return res.status(400).send("Complaint not found or already resolved");
    res.send("Complaint resolved successfully");
  } catch (error) {
    console.error("Error resolving employee complaint:", error);
    res.status(500).send("Server error");
  }
});

module.exports = router;
