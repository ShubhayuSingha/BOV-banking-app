# Bank of Vellorian - Comprehensive System Architecture & Code Audit

This document serves as an exhaustive, feature-by-feature audit of the `Bank of Vellorian` monorepo. It details every user-facing feature, the security protocols, the analytics pipeline, the core financial database layers, and the machine learning background service.

---

## 1. Directory Mapping & Architecture

The repository is structured as a **Modular Monolith** for the primary web application and backend (Node.js/Express), augmented by an **Isolated Microservice** for machine learning inference (Python/FastAPI).

### Complete Directory Tree Structure

```text
e:\dev_projects\bank-of-vellorian
├── .env                        # Environment variables (DB, Redis secrets)
├── .gitignore                  # Git tracking rules
├── app.js                      # Main Node.js/Express entry point
├── package.json                # Node dependencies and scripts
├── src/                        # Node.js backend logic
│   ├── config/
│   │   ├── db.js               # Neon PostgreSQL connection pool
│   │   └── redis.js            # Upstash Redis client configuration
│   ├── middleware/
│   │   └── auth.js             # RBAC and session verification middleware
│   ├── routes/
│   │   ├── admin.routes.js     # Admin functionalities route controller
│   │   ├── analytics.routes.js # Analytics & reporting routes
│   │   ├── auth.routes.js      # Authentication and login handling
│   │   ├── customer.routes.js  # Customer banking operations
│   │   └── employee.routes.js  # Employee operational routes
│   └── services/
│       └── mlService.js        # Axios client for inter-service ML requests
├── ml_service/                 # Isolated Python FastAPI Machine Learning Service
│   ├── main.py                 # FastAPI server and inference endpoint
│   ├── train_model.py          # Random Forest model training script
│   ├── fraud_model.pkl         # Serialized trained ML model
│   └── requirements.txt        # Python dependencies
├── css/                        # Static styling assets
├── js/                         # Static client-side JavaScript (e.g., script.js)
├── images/                     # Static graphical assets
├── scripts/                    # Scripts for DB seeding and utilities
└── *.html                      # Static frontend views (index, account, etc.)
```

---

## 2. Authentication & Security Layer

The authentication system employs a multi-stage verification architecture, encompassing secure credential handling, active session management, Two-Factor Authentication (2FA), and Role-Based Access Control.

### Password Hashing & Brute-Force Prevention

- **`bcrypt`**: Passwords are never stored in plaintext. They are hashed using `bcrypt` during registration and verified during login.
- **Upstash Redis (`@upstash/redis`)**: Redis is utilized for rate-limiting. A user gets 5 login attempts before their account is temporarily locked via an expiring Redis key (`lockout:{role}:{username}`).

### Two-Factor Authentication (2FA / MFA)

Implemented using `otplib` and `qrcode`, the system supports Google and Microsoft Authenticator apps.

- **Setup Phase**: Generates a TOTP secret via `authenticator.generateSecret()` and converts it into a QR code using `qrcode.toDataURL(otpauth)`. The secret is temporarily held in Redis (`setup-2fa:{userType}:{id}`) for 10 minutes until verified.
- **Verification**: User scans the code and enters a 6-digit TOTP token. `authenticator.verify()` checks the token against the secret. If valid, the secret is permanently stored in PostgreSQL.

```javascript
// File location: src/routes/auth.routes.js
const authenticator = otplib.authenticator || otplib;

// Generate secret and QR code data URL
const secret = authenticator.generateSecret();
const getKeyuri = authenticator.keyuri || otplib.keyuri;
const otpauth =
  typeof getKeyuri === "function"
    ? getKeyuri(username, "Bank of Vellorian", secret)
    : `otpauth://totp/Bank%20of%20Vellorian:${username}?secret=${secret}&issuer=Bank%20of%20Vellorian`;
const qrCodeUrl = await qrcode.toDataURL(otpauth);
```

### Role-Based Access Control (RBAC) & Sessions

- **`express-session`**: Generates and signs `connect.sid` cookies.
- **Middleware**: Routes are protected by two middleware functions: `verifyLogin` (checks if a session exists) and `requireRole` (cross-checks `req.session.user.userType` against an allowed array of roles: `customer`, `employee`, `admin`).

```javascript
// File location: src/middleware/auth.js
function requireRole(roles) {
  return (req, res, next) => {
    if (
      !req.session ||
      !req.session.user ||
      !roles.includes(req.session.user.userType)
    ) {
      return res.status(403).send("Not authorized");
    }
    next();
  };
}
```

---

## 3. Core Banking Operations & Database Layer

The financial ledger heavily relies on PostgreSQL to maintain data integrity and strict ACID compliance, utilizing the `pg` package for high-throughput connection pooling.

### Transactions and Row-Level Locking

Transfers between accounts are executed inside SQL transactional blocks (`BEGIN` ... `COMMIT`).
To prevent race conditions (e.g., double-spending attacks), the system utilizes PostgreSQL's **Row-Level Locking (`FOR UPDATE`)** on both the sender and the receiver's account rows.

```javascript
// File location: src/routes/customer.routes.js
await pool.query("BEGIN");

// Lock sender record and verify funds
const senderResult = await pool.query(
  "SELECT balance FROM customers WHERE id = $1 FOR UPDATE",
  [senderId],
);
```

### High-Value Transfer & Risk Approval Workflow

Large transactions (visually represented in the UI as `Approve Transactions`) and transfers flagged by the ML microservice are intercepted and held in a `PENDING` or `PENDING_REVIEW` state.
The funds are debited from the sender but are not credited to the receiver until an **Employee** explicitly approves or rejects the transfer via the employee portal.

```javascript
// File location: src/routes/employee.routes.js
// Approving a held transaction
const newRecipientBalance = recipientBalance + parseFloat(txn.amount);
await pool.query("UPDATE customers SET balance = $1 WHERE id = $2", [
  newRecipientBalance,
  recipientResult.rows[0].id,
]);
await pool.query("UPDATE transactions SET status = $1 WHERE txn_id = $2", [
  "APPROVED",
  txn_id,
]);
```

---

## 4. Machine Learning Fraud Detection Service

To evaluate real-time transaction risk, the system utilizes an isolated Python/FastAPI microservice. This prevents heavy, blocking computations from freezing the Node.js event loop.

### Scikit-Learn Model & Inference

- **`train_model.py`**: Generates synthetic training data based on statistical interactions (transaction amount, hour, frequency, and merchant verification status). It trains a `RandomForestClassifier` and exports it to `fraud_model.pkl` via Joblib.
- **FastAPI Engine (`main.py`)**: Defines a Pydantic `BaseModel` for strong request typing. It converts incoming payloads into Pandas DataFrames and runs model inference to map the fraud probability to a `0-100` risk score.

```python
# File location: ml_service/main.py
class TransactionFeatures(BaseModel):
    amount: float
    hour: int
    recent_count: int
    is_verified: int

@app.post("/predict")
def predict_risk(txn: TransactionFeatures):
    input_data = pd.DataFrame([{
        'amount': txn.amount,
        'hour': txn.hour,
        'recent_count': txn.recent_count,
        'is_verified': txn.is_verified
    }])
    probabilities = model.predict_proba(input_data)[0]
    fraud_probability = float(probabilities[1])
    risk_score = round(fraud_probability * 100)

    return {
        "risk_score": risk_score,
        "fraud_probability": round(fraud_probability, 4),
        "is_high_risk": risk_score >= 60
    }
```

### Cross-Service Circuit Breaker

The Node.js gateway invokes the FastAPI endpoint using `axios`. To adhere to strict real-time banking latency standards, it implements a **3-second timeout circuit-breaker pattern**. If the ML service is down or lagging, the request halts rather than leaving the customer hanging indefinitely.

```javascript
// File location: src/services/mlService.js
const response = await axios.post(
  `${ML_SERVICE_URL}/predict`,
  payload,
  { timeout: 3000 }, // Strict 3s timeout circuit-breaker
);
```

---

## 5. Analytics & Data Visualization

The system provides detailed insights for customers, employees, and administrators via a dedicated analytics pipeline.

### Backend Aggregation Routes

SQL aggregation queries utilize functions like `SUM`, `COUNT`, and `DATE_TRUNC` to calculate metrics efficiently at the database level.

- **Customer**: Cashflow trends (monthly debits vs credits) and category-based spending distributions.
- **Employee**: Macro transaction states and loan approval backlogs.
- **Admin**: System-wide risk distribution metrics grouping historical transactions into Low, Medium, and High-Risk tiers.

```javascript
// File location: src/routes/analytics.routes.js
// Admin Risk Distribution Aggregation
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
```

### Frontend Rendering

On the client side, raw JSON data fetched from these routes is injected into **Chart.js** instances to render interactive, responsive, and real-time visualization graphs across user dashboards. Client-side navigation rendering is handled natively in plain JavaScript.

```javascript
// File location: js/script.js
// Render dynamically generated employee navigation (High-value transfers)
const links = [
  { label: "Dashboard", href: "employee.html" },
  { label: "Approve Transactions", href: "employeeTransactions.html" },
];
```
