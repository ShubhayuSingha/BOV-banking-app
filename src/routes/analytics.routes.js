// File location: src/routes/analytics.routes.js

const express = require("express");
const router = express.Router();
const pool = require("../config/db");

// Middleware to check authentication
function isAuthenticated(req, res, next) {
  if (req.session && req.session.user) {
    return next();
  }
  return res.status(401).json({ error: "Unauthorized access" });
}

// ==========================================
// 1. CUSTOMER ANALYTICS ENDPOINTS
// ==========================================

// GET /api/analytics/customer/cashflow
// Returns monthly debits vs credits for the logged-in customer
router.get("/customer/cashflow", isAuthenticated, async (req, res) => {
  const username = req.session.user.username;

  try {
    const query = `
      SELECT 
        DATE_TRUNC('month', timestamp) AS month,
        SUM(CASE WHEN receiver = $1 THEN amount ELSE 0 END) AS total_income,
        SUM(CASE WHEN sender = $1 THEN amount ELSE 0 END) AS total_expense
      FROM transactions
      WHERE (sender = $1 OR receiver = $1) AND status = 'APPROVED'
      GROUP BY month
      ORDER BY month ASC
      LIMIT 6;
    `;
    const result = await pool.query(query, [username]);
    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching customer cashflow:", err);
    res.status(500).json({ error: "Failed to calculate cashflow analytics" });
  }
});

// GET /api/analytics/customer/categories
// Returns spending grouped by category for the logged-in customer
router.get("/customer/categories", isAuthenticated, async (req, res) => {
  const username = req.session.user.username;

  try {
    const query = `
      SELECT 
        category, 
        SUM(amount) AS total_amount,
        COUNT(txn_id) AS transaction_count
      FROM transactions
      WHERE sender = $1 AND status = 'APPROVED'
      GROUP BY category
      ORDER BY total_amount DESC;
    `;
    const result = await pool.query(query, [username]);
    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching category analytics:", err);
    res
      .status(500)
      .json({ error: "Failed to calculate category distribution" });
  }
});

// ==========================================
// 2. EMPLOYEE ANALYTICS ENDPOINTS
// ==========================================

// GET /api/analytics/employee/transactions-overview
// Returns counts of transactions grouped by status (APPROVED, PENDING, PENDING_REVIEW, REJECTED)
router.get(
  "/employee/transactions-overview",
  isAuthenticated,
  async (req, res) => {
    try {
      const query = `
      SELECT 
        status, 
        COUNT(txn_id) AS total_count,
        COALESCE(SUM(amount), 0) AS total_volume
      FROM transactions
      GROUP BY status;
    `;
      const result = await pool.query(query);
      res.json(result.rows);
    } catch (err) {
      console.error("Error fetching employee transaction overview:", err);
      res
        .status(500)
        .json({ error: "Failed to calculate transaction analytics" });
    }
  },
);

// GET /api/analytics/employee/loans-overview
// Returns counts of loans grouped by status
router.get("/employee/loans-overview", isAuthenticated, async (req, res) => {
  try {
    const query = `
      SELECT 
        status, 
        COUNT(loan_id) AS total_count,
        COALESCE(SUM(amount), 0) AS total_amount
      FROM loans
      GROUP BY status;
    `;
    const result = await pool.query(query);
    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching employee loan overview:", err);
    res.status(500).json({ error: "Failed to calculate loan analytics" });
  }
});

// ==========================================
// 3. ADMIN ANALYTICS ENDPOINTS
// ==========================================

// GET /api/analytics/admin/risk-distribution
// Returns count of system transactions grouped by risk score buckets
router.get("/admin/risk-distribution", isAuthenticated, async (req, res) => {
  try {
    const query = `
      SELECT 
        CASE 
          WHEN risk_score < 50 THEN 'Low Risk (0-49)'
          WHEN risk_score BETWEEN 50 AND 74 THEN 'Medium Risk (50-74)'
          ELSE 'High Risk (75-100)'
        END AS risk_tier,
        COUNT(txn_id) AS total_transactions,
        COALESCE(SUM(amount), 0) AS total_volume
      FROM transactions
      GROUP BY risk_tier
      ORDER BY risk_tier ASC;
    `;
    const result = await pool.query(query);
    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching risk distribution:", err);
    res.status(500).json({ error: "Failed to calculate risk metrics" });
  }
});

module.exports = router;
