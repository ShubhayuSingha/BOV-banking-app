// app.js
require('dotenv').config();
const express = require('express');
const session = require('express-session');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

// Setup PostgreSQL connection pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

// Configure session middleware
app.use(session({
  secret: 'your_secret_key', // Use a secure, random secret in production
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false } // Set to true if using HTTPS
}));

// Middleware to parse JSON and URL-encoded data
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files (HTML, CSS, JS) from the project root
app.use(express.static(path.join(__dirname)));

// Helper function to generate unique transaction ID
async function generateTxnId() {
  // Get the last transaction ID
  const result = await pool.query('SELECT txn_id FROM transactions ORDER BY txn_id DESC LIMIT 1');
  if (result.rows.length === 0) {
    return 'TXN00001';
  }
  const lastTxnId = result.rows[0].txn_id;
  const numberPart = parseInt(lastTxnId.substring(3));
  const newNumber = numberPart + 1;
  return 'TXN' + newNumber.toString().padStart(5, '0');
}

// Unified POST /login endpoint for customers, employees, and admins
app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  let user;
  let userType; // 'customer', 'employee', or 'admin'
  
  try {
    // Check in the customers table
    let result = await pool.query('SELECT * FROM customers WHERE username = $1', [username]);
    if (result.rowCount > 0) {
      user = result.rows[0];
      userType = 'customer';
    } else {
      // Check in the employees table
      result = await pool.query('SELECT * FROM employees WHERE username = $1', [username]);
      if (result.rowCount > 0) {
        user = result.rows[0];
        userType = 'employee';
      } else {
        // Check in the admins table
        result = await pool.query('SELECT * FROM admins WHERE username = $1', [username]);
        if (result.rowCount > 0) {
          user = result.rows[0];
          userType = 'admin';
        }
      }
    }
    
    if (!user) {
      return res.status(401).send('Incorrect userid/password');
    }
    
    const isValid = await bcrypt.compare(password, user.password);
    if (!isValid) {
      return res.status(401).send('Incorrect userid/password');
    }
    
    // Save user info in session along with their type
    req.session.user = { id: user.id, username: user.username, userType: userType };
    // Return userType for front-end redirection
    res.send(userType);
    
  } catch (error) {
    console.error('Error during login:', error);
    res.status(500).send('Server error');
  }
});

// GET /balance endpoint to fetch the balance for the logged-in customer
app.get('/balance', async (req, res) => {
  if (!req.session.user) {
    return res.status(401).send('Not logged in');
  }
  const userId = req.session.user.id;
  try {
    const result = await pool.query('SELECT balance FROM customers WHERE id = $1', [userId]);
    if (result.rowCount === 0) {
      return res.status(404).send('User not found');
    }
    const balance = result.rows[0].balance;
    res.json({ balance });
  } catch (error) {
    console.error('Error fetching balance:', error);
    res.status(500).send('Server error');
  }
});

// POST /logout endpoint
app.post('/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) {
      console.error("Error destroying session:", err);
      return res.status(500).send('Error logging out');
    }
    res.send('logged out');
  });
});

// POST /sendMoney endpoint
app.post('/sendMoney', async (req, res) => {
  if (!req.session.user) {
    return res.status(401).send('Not logged in');
  }
  const senderId = req.session.user.id;
  const senderUsername = req.session.user.username;
  const { recipient, amount } = req.body;
  
  const amountNum = parseFloat(amount);
  console.log("Received amount:", amount, "Converted amount:", amountNum);
  
  if (!recipient || isNaN(amountNum) || amountNum <= 0) {
    return res.status(400).send('Invalid input');
  }
  if (recipient === senderUsername) {
    return res.status(400).send('Cannot send money to yourself');
  }
  
  try {
    await pool.query('BEGIN');
    // Fetch sender's balance with lock
    const senderResult = await pool.query('SELECT balance FROM customers WHERE id = $1 FOR UPDATE', [senderId]);
    if (senderResult.rowCount === 0) {
      await pool.query('ROLLBACK');
      return res.status(404).send('Sender not found');
    }
    const senderBalance = parseFloat(senderResult.rows[0].balance);
    if (senderBalance < amountNum) {
      await pool.query('ROLLBACK');
      return res.status(400).send('Insufficient funds');
    }
    
    const txnId = await generateTxnId();
    
    if (amountNum > 50000) {
      // For amounts > 50,000, process as pending:
      const newSenderBalance = senderBalance - amountNum;
      await pool.query('UPDATE customers SET balance = $1 WHERE id = $2', [newSenderBalance, senderId]);
      await pool.query(
        'INSERT INTO transactions (txn_id, sender, receiver, amount, status) VALUES ($1, $2, $3, $4, $5)',
        [txnId, senderUsername, recipient, amountNum, 'PENDING']
      );
      console.log("Transaction inserted as PENDING");
      await pool.query('COMMIT');
      return res.send('Transaction pending approval');
    } else {
      // For amounts <= 50,000, process immediately:
      const newSenderBalance = senderBalance - amountNum;
      await pool.query('UPDATE customers SET balance = $1 WHERE id = $2', [newSenderBalance, senderId]);
      const recipientResult = await pool.query('SELECT id, balance FROM customers WHERE username = $1 FOR UPDATE', [recipient]);
      if (recipientResult.rowCount === 0) {
        await pool.query('ROLLBACK');
        return res.status(404).send('Recipient not found');
      }
      const recipientBalance = parseFloat(recipientResult.rows[0].balance);
      const newRecipientBalance = recipientBalance + amountNum;
      await pool.query('UPDATE customers SET balance = $1 WHERE id = $2', [newRecipientBalance, recipientResult.rows[0].id]);
      await pool.query(
        'INSERT INTO transactions (txn_id, sender, receiver, amount, status) VALUES ($1, $2, $3, $4, $5)',
        [txnId, senderUsername, recipient, amountNum, 'APPROVED']
      );
      console.log("Transaction inserted as APPROVED");
      await pool.query('COMMIT');
      return res.send('success');
    }
  } catch (error) {
    await pool.query('ROLLBACK');
    console.error('Error during sendMoney:', error);
    res.status(500).send('Server error');
  }
});

// POST /employee/approveLargeTransaction endpoint for approving pending transactions > 50,000
app.post('/employee/approveLargeTransaction', async (req, res) => {
  if (!req.session.user || req.session.user.userType !== 'employee') {
    return res.status(401).send('Not authorized');
  }
  const { txn_id } = req.body;
  if (!txn_id) {
    return res.status(400).send('Transaction ID required.');
  }
  
  try {
    await pool.query('BEGIN');
    const txnResult = await pool.query('SELECT * FROM transactions WHERE txn_id = $1 FOR UPDATE', [txn_id]);
    if (txnResult.rowCount === 0) {
      await pool.query('ROLLBACK');
      return res.status(404).send('Transaction not found');
    }
    const txn = txnResult.rows[0];
    if (txn.status !== 'PENDING') {
      await pool.query('ROLLBACK');
      return res.status(400).send('Transaction already approved or cancelled');
    }
    // Fetch recipient info with lock
    const recipientResult = await pool.query('SELECT id, balance FROM customers WHERE username = $1 FOR UPDATE', [txn.receiver]);
    if (recipientResult.rowCount === 0) {
      await pool.query('ROLLBACK');
      return res.status(404).send('Recipient not found');
    }
    const recipientBalance = parseFloat(recipientResult.rows[0].balance);
    const newRecipientBalance = recipientBalance + parseFloat(txn.amount);
    await pool.query('UPDATE customers SET balance = $1 WHERE id = $2', [newRecipientBalance, recipientResult.rows[0].id]);
    // Update transaction status
    await pool.query('UPDATE transactions SET status = $1 WHERE txn_id = $2', ['APPROVED', txn_id]);
    await pool.query('COMMIT');
    res.send('Transaction approved successfully');
  } catch (error) {
    await pool.query('ROLLBACK');
    console.error('Error approving large transaction:', error);
    res.status(500).send('Server error');
  }
});

// POST /employee/rejectLargeTransaction endpoint for rejecting pending transactions > 50,000
app.post('/employee/rejectLargeTransaction', async (req, res) => {
  if (!req.session.user || req.session.user.userType !== 'employee') {
    return res.status(401).send('Not authorized');
  }
  const { txn_id } = req.body;
  if (!txn_id) {
    return res.status(400).send('Transaction ID required.');
  }
  
  try {
    await pool.query('BEGIN');
    // Fetch the pending transaction with a lock
    const txnResult = await pool.query('SELECT * FROM transactions WHERE txn_id = $1 FOR UPDATE', [txn_id]);
    if (txnResult.rowCount === 0) {
      await pool.query('ROLLBACK');
      return res.status(404).send('Transaction not found');
    }
    const txn = txnResult.rows[0];
    if (txn.status !== 'PENDING') {
      await pool.query('ROLLBACK');
      return res.status(400).send('Transaction is not pending');
    }
    
    // Refund the sender: the pending transaction deducted funds earlier
    const senderResult = await pool.query('SELECT id, balance FROM customers WHERE username = $1 FOR UPDATE', [txn.sender]);
    if (senderResult.rowCount === 0) {
      await pool.query('ROLLBACK');
      return res.status(404).send('Sender not found');
    }
    const senderBalance = parseFloat(senderResult.rows[0].balance);
    const amount = parseFloat(txn.amount);
    const newSenderBalance = senderBalance + amount;
    await pool.query('UPDATE customers SET balance = $1 WHERE id = $2', [newSenderBalance, senderResult.rows[0].id]);
    
    // Update the transaction's status to "REJECTED"
    await pool.query('UPDATE transactions SET status = $1 WHERE txn_id = $2', ['REJECTED', txn_id]);
    
    await pool.query('COMMIT');
    res.send('Transaction rejected successfully');
  } catch (error) {
    await pool.query('ROLLBACK');
    console.error('Error rejecting transaction:', error);
    res.status(500).send('Server error');
  }
});

app.get('/transactions', async (req, res) => {
  if (!req.session.user) {
    return res.status(401).send('Not logged in');
  }
  const currentUser = req.session.user.username;
  try {
    // Fetch transactions where the current user is either sender or receiver
    const result = await pool.query(
      "SELECT * FROM transactions WHERE sender = $1 OR receiver = $1 ORDER BY timestamp DESC",
      [currentUser]
    );
    
    const transactions = result.rows.filter(txn => {
      // For receiver, pending transactions are not shown.
      if (txn.status === 'PENDING' && txn.receiver === currentUser) {
        return false;
      }
      return true;
    }).map(txn => {
      let type, name;
      if (txn.sender === currentUser) {
        if (txn.status === 'PENDING') {
          type = 'Pending';
        } else if (txn.status === 'REVERSED') {
          type = 'Reversed';
        } else if (txn.status === 'REJECTED') {
          type = 'Rejected';
        } else {
          type = 'Debit';
        }
        name = txn.receiver;
      } else if (txn.receiver === currentUser) {
        if (txn.status === 'REJECTED') {
          type = 'Rejected';
        } else {
          type = 'Credit';
        }
        name = txn.sender;
      }
      const dateObj = new Date(txn.timestamp);
      const date = dateObj.toLocaleDateString('en-GB'); // DD/MM/YYYY
      const time = dateObj.toLocaleTimeString(); // Time as is
      return {
        txn_id: txn.txn_id,
        name,
        dateTime: date + ' ' + time,
        type,
        amount: txn.amount,
        status: txn.status
      };
    });
    
    res.json(transactions);
  } catch (error) {
    console.error('Error fetching transactions:', error);
    res.status(500).send('Server error');
  }
});



// ----------------------
// Customer Loan Functionality
// ----------------------

// POST /applyLoan endpoint for customers to apply for a loan
app.post('/applyLoan', async (req, res) => {
  if (!req.session.user) {
    return res.status(401).send('Not logged in');
  }
  const applier = req.session.user.username;
  const { loan_type, amount, message } = req.body;
  
  if (!loan_type || isNaN(amount) || amount <= 0) {
    return res.status(400).send('Invalid input');
  }
  
  try {
    async function generateLoanId() {
      const result = await pool.query("SELECT loan_id FROM loans ORDER BY loan_id DESC LIMIT 1");
      if (result.rows.length === 0) {
        return "LOAN00001";
      }
      const lastLoanId = result.rows[0].loan_id;
      const numberPart = parseInt(lastLoanId.substring(4));
      const newNumber = numberPart + 1;
      return "LOAN" + newNumber.toString().padStart(5, '0');
    }
    
    const loan_id = await generateLoanId();
    await pool.query(
      'INSERT INTO loans (loan_id, loan_type, amount, status, approver, applier, message, applied_timestamp, approval_timestamp) VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP, NULL)',
      [loan_id, loan_type, amount, 'NOT APPROVED', null, applier, message]
    );
    res.send('Loan application submitted successfully');
  } catch (error) {
    console.error('Error applying for loan:', error);
    res.status(500).send('Server error');
  }
});

// GET /loans endpoint to fetch all loans for the logged-in customer
app.get('/loans', async (req, res) => {
  if (!req.session.user) {
    return res.status(401).send('Not logged in');
  }
  const applier = req.session.user.username;
  try {
    const result = await pool.query("SELECT * FROM loans WHERE applier = $1 ORDER BY loan_id DESC", [applier]);
    res.json(result.rows);
  } catch(error) {
    console.error('Error fetching loans:', error);
    res.status(500).send('Server error');
  }
});

// ----------------------
// Employee Loan Endpoints
// ----------------------

// POST /employee/approveLoan endpoint for loan approval and crediting customer's account
app.post('/employee/approveLoan', async (req, res) => {
  if (!req.session.user || req.session.user.userType !== 'employee') {
    return res.status(401).send('Not authorized');
  }
  const { loan_id } = req.body;
  if (!loan_id) {
    return res.status(400).send('Loan ID required');
  }
  
  try {
    const employeeUsername = req.session.user.username;
    await pool.query('BEGIN');
    const loanResult = await pool.query("SELECT * FROM loans WHERE loan_id = $1 FOR UPDATE", [loan_id]);
    if (loanResult.rowCount === 0) {
      await pool.query('ROLLBACK');
      return res.status(404).send('Loan not found');
    }
    const loan = loanResult.rows[0];
    if (loan.status === 'APPROVED') {
      await pool.query('ROLLBACK');
      return res.status(400).send('Loan already approved');
    }
    await pool.query(
      "UPDATE loans SET status = 'APPROVED', approver = $1, approval_timestamp = CURRENT_TIMESTAMP WHERE loan_id = $2",
      [employeeUsername, loan_id]
    );
    const amount = parseFloat(loan.amount);
    await pool.query(
      "UPDATE customers SET balance = balance + $1 WHERE username = $2",
      [amount, loan.applier]
    );
    await pool.query('COMMIT');
    res.send('Loan approved and credited successfully');
  } catch (error) {
    await pool.query('ROLLBACK');
    console.error('Error approving loan:', error);
    res.status(500).send('Server error');
  }
});

// ----------------------
// Customer Complaint Endpoints
// ----------------------

// POST /customer/complaint endpoint for filing a complaint (by customer)
app.post('/customer/complaint', async (req, res) => {
  if (!req.session.user || req.session.user.userType !== 'customer') {
    return res.status(401).send('Not authorized');
  }
  const applier = req.session.user.username;
  const { c_message } = req.body;
  if (!c_message || c_message.trim() === '') {
    return res.status(400).send('Complaint message is required');
  }
  try {
    await pool.query(
      'INSERT INTO customer_complaints (applier, c_message) VALUES ($1, $2)',
      [applier, c_message]
    );
    res.send('Complaint filed successfully');
  } catch (error) {
    console.error('Error filing complaint:', error);
    res.status(500).send('Server error');
  }
});

// GET /customer/complaints endpoint for a customer to view their own complaints
app.get('/customer/complaints', async (req, res) => {
  if (!req.session.user || req.session.user.userType !== 'customer') {
    return res.status(401).send('Not authorized');
  }
  const applier = req.session.user.username;
  try {
    const result = await pool.query(
      'SELECT * FROM customer_complaints WHERE applier = $1 ORDER BY applied_timestamp DESC',
      [applier]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching customer complaints:', error);
    res.status(500).send('Server error');
  }
});

// ----------------------
// Employee Complaint Endpoints
// ----------------------

// GET /employee/customerComplaints endpoint for employees to fetch unresolved customer complaints
app.get('/employee/customerComplaints', async (req, res) => {
  if (!req.session.user || req.session.user.userType !== 'employee') {
    return res.status(401).send('Not authorized');
  }
  try {
    // Return all customer complaints (both resolved and unresolved)
    const result = await pool.query(
      "SELECT * FROM customer_complaints ORDER BY applied_timestamp DESC"
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching customer complaints for employee:', error);
    res.status(500).send('Server error');
  }
});

// POST /employee/resolveComplaint endpoint for employees to resolve a customer complaint
app.post('/employee/resolveComplaint', async (req, res) => {
  if (!req.session.user || req.session.user.userType !== 'employee') {
    return res.status(401).send('Not authorized');
  }
  const resolver = req.session.user.username;
  const { ccomp_id, e_message } = req.body;
  if (!ccomp_id || !e_message || e_message.trim() === '') {
    return res.status(400).send('Complaint ID and resolution message are required');
  }
  try {
    const result = await pool.query(
      "UPDATE customer_complaints SET status = 'resolved', resolver = $1, e_message = $2, resolved_timestamp = CURRENT_TIMESTAMP WHERE ccomp_id = $3 AND status = 'unresolved'",
      [resolver, e_message, ccomp_id]
    );
    if (result.rowCount === 0) {
      return res.status(400).send('Complaint not found or already resolved');
    }
    res.send('Complaint resolved successfully');
  } catch (error) {
    console.error('Error resolving complaint:', error);
    res.status(500).send('Server error');
  }
});

// ----------------------
// Admin Endpoints (stubs)
// ----------------------
app.post('/admin/answerComplaint', (req, res) => {
  res.send('Employee complaints answered (stub).');
});

app.post('/admin/reverseTransaction', async (req, res) => {
  if (!req.session.user || req.session.user.userType !== 'admin') {
    return res.status(401).send('Not authorized');
  }
  const { txn_id } = req.body;
  if (!txn_id) {
    return res.status(400).send('Transaction ID required.');
  }
  try {
    await pool.query('BEGIN');
    // Fetch the transaction with a lock
    const txnResult = await pool.query('SELECT * FROM transactions WHERE txn_id = $1 FOR UPDATE', [txn_id]);
    if (txnResult.rowCount === 0) {
      await pool.query('ROLLBACK');
      return res.status(404).send('Transaction not found');
    }
    const txn = txnResult.rows[0];
    // Check if transaction is already reversed
    if (txn.status === 'REVERSED') {
      await pool.query('ROLLBACK');
      return res.status(400).send('Transaction already reversed');
    }
    // Only allow reversing if the transaction is currently approved
    if (txn.status !== 'APPROVED') {
      await pool.query('ROLLBACK');
      return res.status(400).send('Only approved transactions can be reversed');
    }
    
    // Fetch sender and receiver details with row-level locks
    const senderResult = await pool.query('SELECT id, balance FROM customers WHERE username = $1 FOR UPDATE', [txn.sender]);
    const receiverResult = await pool.query('SELECT id, balance FROM customers WHERE username = $1 FOR UPDATE', [txn.receiver]);
    
    if (senderResult.rowCount === 0 || receiverResult.rowCount === 0) {
      await pool.query('ROLLBACK');
      return res.status(404).send('Sender or receiver not found');
    }
    
    const senderBalance = parseFloat(senderResult.rows[0].balance);
    const receiverBalance = parseFloat(receiverResult.rows[0].balance);
    const amount = parseFloat(txn.amount);
    
    // Check if receiver has sufficient funds to reverse (optional, depending on your business rules)
    if (receiverBalance < amount) {
      await pool.query('ROLLBACK');
      return res.status(400).send('Receiver does not have sufficient funds to reverse the transaction');
    }
    
    // Reverse the transaction: add amount back to sender and deduct from receiver
    const newSenderBalance = senderBalance + amount;
    const newReceiverBalance = receiverBalance - amount;
    
    await pool.query('UPDATE customers SET balance = $1 WHERE id = $2', [newSenderBalance, senderResult.rows[0].id]);
    await pool.query('UPDATE customers SET balance = $1 WHERE id = $2', [newReceiverBalance, receiverResult.rows[0].id]);
    
    // Update the transaction's status to 'REVERSED'
    await pool.query('UPDATE transactions SET status = $1 WHERE txn_id = $2', ['REVERSED', txn_id]);
    
    await pool.query('COMMIT');
    res.send('Transaction reversed successfully');
  } catch (error) {
    await pool.query('ROLLBACK');
    console.error('Error reversing transaction:', error);
    res.status(500).send('Server error');
  }
});


// GET /employee/loans endpoint for employees to fetch all loans with optional sorting
app.get('/employee/loans', async (req, res) => {
  if (!req.session.user || req.session.user.userType !== 'employee') {
    return res.status(401).send('Not authorized');
  }
  
  let { sort_by, order } = req.query;
  const validSortFields = ['applied_timestamp', 'status', 'amount'];
  if (!validSortFields.includes(sort_by)) {
    sort_by = 'applied_timestamp';
  }
  if (order !== 'asc' && order !== 'desc') {
    order = 'desc';
  }
  
  try {
    const result = await pool.query(`SELECT * FROM loans ORDER BY ${sort_by} ${order.toUpperCase()}`);
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching employee loans:', error);
    res.status(500).send('Server error');
  }
});

// ----------------------
// New Endpoint: GET /employee/pendingTransactions
// This endpoint returns all transactions (money transfers) that are pending and over 50,000
app.get('/employee/pendingTransactions', async (req, res) => {
  if (!req.session.user || req.session.user.userType !== 'employee') {
    return res.status(401).send('Not authorized');
  }
  try {
    // Fetch transactions with status 'PENDING' and amount > 50000
    const result = await pool.query("SELECT * FROM transactions WHERE status = 'PENDING' AND amount > 50000 ORDER BY timestamp DESC");
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching pending transactions:', error);
    res.status(500).send('Server error');
  }
});

// POST /employee/complaint - Employee files a complaint
app.post('/employee/complaint', async (req, res) => {
  if (!req.session.user || req.session.user.userType !== 'employee') {
    return res.status(401).send('Not authorized');
  }
  const applier = req.session.user.username;
  const { e_message } = req.body;
  if (!e_message || e_message.trim() === '') {
    return res.status(400).send('Complaint message is required');
  }
  try {
    await pool.query(
      'INSERT INTO employee_complaints (applier, e_message) VALUES ($1, $2)',
      [applier, e_message]
    );
    res.send('Complaint filed successfully');
  } catch (error) {
    console.error('Error filing employee complaint:', error);
    res.status(500).send('Server error');
  }
});

// GET /employee/complaints - Employee views their own filed complaints
app.get('/employee/complaints', async (req, res) => {
  if (!req.session.user || req.session.user.userType !== 'employee') {
    return res.status(401).send('Not authorized');
  }
  const applier = req.session.user.username;
  try {
    const result = await pool.query(
      'SELECT * FROM employee_complaints WHERE applier = $1 ORDER BY applied_timestamp DESC',
      [applier]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching employee complaints:', error);
    res.status(500).send('Server error');
  }
});

// GET /admin/employeeComplaints - Admin views all employee complaints
app.get('/admin/employeeComplaints', async (req, res) => {
  if (!req.session.user || req.session.user.userType !== 'admin') {
    return res.status(401).send('Not authorized');
  }
  try {
    const result = await pool.query(
      'SELECT * FROM employee_complaints ORDER BY applied_timestamp DESC'
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching employee complaints for admin:', error);
    res.status(500).send('Server error');
  }
});

// POST /admin/resolveEmployeeComplaint - Admin resolves an employee complaint
app.post('/admin/resolveEmployeeComplaint', async (req, res) => {
  if (!req.session.user || req.session.user.userType !== 'admin') {
    return res.status(401).send('Not authorized');
  }
  const resolver = req.session.user.username;
  const { ecomp_id, a_message } = req.body;
  if (!ecomp_id || !a_message || a_message.trim() === '') {
    return res.status(400).send('Complaint ID and resolution message are required');
  }
  try {
    const result = await pool.query(
      "UPDATE employee_complaints SET status = 'resolved', resolver = $1, a_message = $2, resolved_timestamp = CURRENT_TIMESTAMP WHERE ecomp_id = $3 AND status = 'unresolved'",
      [resolver, a_message, ecomp_id]
    );
    if (result.rowCount === 0) {
      return res.status(400).send('Complaint not found or already resolved');
    }
    res.send('Complaint resolved successfully');
  } catch (error) {
    console.error('Error resolving employee complaint:', error);
    res.status(500).send('Server error');
  }
});



// Start the server
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
