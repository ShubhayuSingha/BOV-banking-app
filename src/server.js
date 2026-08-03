// File location: src/server.js

require("dotenv").config();
const express = require("express");
const session = require("express-session");
const path = require("path");

const authRoutes = require("./routes/auth.routes");
// Note: You can split remaining features into customer.routes.js, employee.routes.js, etc.

const app = express();
const port = process.env.PORT || 3000;

app.use(
  session({
    secret: process.env.SESSION_SECRET || "fallback_secret_key", //[cite: 4]
    resave: false, //[cite: 4]
    saveUninitialized: false,
    rolling: true, // Resets the timer on active requests
    cookie: {
      secure: false, //[cite: 4]
      maxAge: 1000 * 60 * 5, // 5 minutes inactivity limit
    },
  }),
);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "../")));

// Route Mounting
app.use("/auth", authRoutes);

app.listen(port, () => {
  console.log(`Modular Server running on port ${port}`);
});
