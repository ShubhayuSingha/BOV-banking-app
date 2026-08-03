// app.js
require("dotenv").config();
const express = require("express");
const session = require("express-session");
const path = require("path");

// Import your newly modularized route architectures
const authRoutes = require("./src/routes/auth.routes");
const customerRoutes = require("./src/routes/customer.routes");
const employeeRoutes = require("./src/routes/employee.routes");
const adminRoutes = require("./src/routes/admin.routes");
const analyticsRoutes = require("./src/routes/analytics.routes");

const app = express();
const port = process.env.PORT || 3000;

// Configure session middleware
app.use(
  session({
    secret: process.env.SESSION_SECRET || "your_secret_key", // Use a secure, random secret in production
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false }, // Set to true if using HTTPS
  }),
);

// Middleware to parse JSON and URL-encoded data
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files (HTML, CSS, JS) from the project root
app.use(express.static(path.join(__dirname)));

// Route Mounting to Specific Base Path Prefixes
app.use("/auth", authRoutes);
app.use("/customer", customerRoutes);
app.use("/employee", employeeRoutes);
app.use("/admin", adminRoutes);
app.use("/api/analytics", analyticsRoutes);

// Start the server
app.listen(port, () => {
  console.log(`Modular Monolith Gatekeeper running on port ${port}`);
});
