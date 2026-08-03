// File location: src/routes/employee.routes.js

const express = require("express");
const router = express.Router();
const pool = require("../config/db");
const { verifyLogin, requireRole } = require("../middleware/auth");

// Protect all employee endpoints
router.use(verifyLogin);
router.use(requireRole(["employee"]));

// POST /employee/approveLargeTransaction
router.post("/approveLargeTransaction", async (req, res) => {
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

    // Allow both PENDING and PENDING_REVIEW statuses
    if (txn.status !== "PENDING" && txn.status !== "PENDING_REVIEW") {
      await pool.query("ROLLBACK");
      return res
        .status(400)
        .send("Transaction already processed or invalid status");
    }

    const recipientResult = await pool.query(
      "SELECT id, balance FROM customers WHERE username = $1 FOR UPDATE",
      [txn.receiver],
    );
    if (recipientResult.rowCount === 0) {
      await pool.query("ROLLBACK");
      return res.status(404).send("Recipient not found");
    }
    const recipientBalance = parseFloat(recipientResult.rows[0].balance);
    const newRecipientBalance = recipientBalance + parseFloat(txn.amount);
    await pool.query("UPDATE customers SET balance = $1 WHERE id = $2", [
      newRecipientBalance,
      recipientResult.rows[0].id,
    ]);
    await pool.query("UPDATE transactions SET status = $1 WHERE txn_id = $2", [
      "APPROVED",
      txn_id,
    ]);
    await pool.query("COMMIT");
    res.send("Transaction approved successfully");
  } catch (error) {
    await pool.query("ROLLBACK");
    console.error("Error approving transaction:", error);
    res.status(500).send("Server error");
  }
});

// POST /employee/rejectLargeTransaction
router.post("/rejectLargeTransaction", async (req, res) => {
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

    // Allow both PENDING and PENDING_REVIEW statuses
    if (txn.status !== "PENDING" && txn.status !== "PENDING_REVIEW") {
      await pool.query("ROLLBACK");
      return res.status(400).send("Transaction is not pending review");
    }

    const senderResult = await pool.query(
      "SELECT id, balance FROM customers WHERE username = $1 FOR UPDATE",
      [txn.sender],
    );
    if (senderResult.rowCount === 0) {
      await pool.query("ROLLBACK");
      return res.status(404).send("Sender not found");
    }
    const senderBalance = parseFloat(senderResult.rows[0].balance);
    const newSenderBalance = senderBalance + parseFloat(txn.amount);
    await pool.query("UPDATE customers SET balance = $1 WHERE id = $2", [
      newSenderBalance,
      senderResult.rows[0].id,
    ]);
    await pool.query("UPDATE transactions SET status = $1 WHERE txn_id = $2", [
      "REJECTED",
      txn_id,
    ]);

    await pool.query("COMMIT");
    res.send("Transaction rejected successfully");
  } catch (error) {
    await pool.query("ROLLBACK");
    console.error("Error rejecting transaction:", error);
    res.status(500).send("Server error");
  }
});

// GET /employee/pendingTransactions
router.get("/pendingTransactions", async (req, res) => {
  try {
    // Fetch all transactions flagged for review (including ML risk flags and high amounts)
    const result = await pool.query(
      "SELECT * FROM transactions WHERE status IN ('PENDING', 'PENDING_REVIEW') ORDER BY timestamp DESC",
    );
    res.json(result.rows);
  } catch (error) {
    console.error("Error fetching pending transactions:", error);
    res.status(500).send("Server error");
  }
});

// POST /employee/approveLoan
router.post("/approveLoan", async (req, res) => {
  const { loan_id } = req.body;
  if (!loan_id) return res.status(400).send("Loan ID required");

  try {
    const employeeUsername = req.session.user.username;
    await pool.query("BEGIN");
    const loanResult = await pool.query(
      "SELECT * FROM loans WHERE loan_id = $1 FOR UPDATE",
      [loan_id],
    );
    if (loanResult.rowCount === 0) {
      await pool.query("ROLLBACK");
      return res.status(404).send("Loan not found");
    }
    const loan = loanResult.rows[0];
    if (loan.status === "APPROVED") {
      await pool.query("ROLLBACK");
      return res.status(400).send("Loan already approved");
    }
    await pool.query(
      "UPDATE loans SET status = 'APPROVED', approver = $1, approval_timestamp = CURRENT_TIMESTAMP WHERE loan_id = $2",
      [employeeUsername, loan_id],
    );
    await pool.query(
      "UPDATE customers SET balance = balance + $1 WHERE username = $2",
      [parseFloat(loan.amount), loan.applier],
    );
    await pool.query("COMMIT");
    res.send("Loan approved and credited successfully");
  } catch (error) {
    await pool.query("ROLLBACK");
    console.error("Error approving loan:", error);
    res.status(500).send("Server error");
  }
});

// GET /employee/loans
router.get("/loans", async (req, res) => {
  let { sort_by, order } = req.query;
  const validSortFields = ["applied_timestamp", "status", "amount"];
  if (!validSortFields.includes(sort_by)) sort_by = "applied_timestamp";
  if (order !== "asc" && order !== "desc") order = "desc";

  try {
    const result = await pool.query(
      `SELECT * FROM loans ORDER BY ${sort_by} ${order.toUpperCase()}`,
    );
    res.json(result.rows);
  } catch (error) {
    console.error("Error fetching employee loans:", error);
    res.status(500).send("Server error");
  }
});

// GET /employee/customerComplaints
router.get("/customerComplaints", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM customer_complaints ORDER BY applied_timestamp DESC",
    );
    res.json(result.rows);
  } catch (error) {
    console.error("Error fetching customer complaints:", error);
    res.status(500).send("Server error");
  }
});

// POST /employee/resolveComplaint
router.post("/resolveComplaint", async (req, res) => {
  const resolver = req.session.user.username;
  const { ccomp_id, e_message } = req.body;
  if (!ccomp_id || !e_message || e_message.trim() === "") {
    return res
      .status(400)
      .send("Complaint ID and resolution message are required");
  }
  try {
    const result = await pool.query(
      "UPDATE customer_complaints SET status = 'resolved', resolver = $1, e_message = $2, resolved_timestamp = CURRENT_TIMESTAMP WHERE ccomp_id = $3 AND status = 'unresolved'",
      [resolver, e_message, ccomp_id],
    );
    if (result.rowCount === 0)
      return res.status(400).send("Complaint not found or already resolved");
    res.send("Complaint resolved successfully");
  } catch (error) {
    console.error("Error resolving complaint:", error);
    res.status(500).send("Server error");
  }
});

// POST /employee/complaint
router.post("/complaint", async (req, res) => {
  const applier = req.session.user.username;
  const { e_message } = req.body;
  if (!e_message || e_message.trim() === "")
    return res.status(400).send("Complaint message is required");
  try {
    await pool.query(
      "INSERT INTO employee_complaints (applier, e_message) VALUES ($1, $2)",
      [applier, e_message],
    );
    res.send("Complaint filed successfully");
  } catch (error) {
    console.error("Error filing employee complaint:", error);
    res.status(500).send("Server error");
  }
});

// GET /employee/complaints
router.get("/complaints", async (req, res) => {
  const applier = req.session.user.username;
  try {
    const result = await pool.query(
      "SELECT * FROM employee_complaints WHERE applier = $1 ORDER BY applied_timestamp DESC",
      [applier],
    );
    res.json(result.rows);
  } catch (error) {
    console.error("Error fetching employee complaints:", error);
    res.status(500).send("Server error");
  }
});

module.exports = router;
