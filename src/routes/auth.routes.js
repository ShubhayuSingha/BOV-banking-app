// File location: src/routes/auth.routes.js

const express = require("express");
const router = express.Router();
const bcrypt = require("bcrypt");
const qrcode = require("qrcode");
const otplib = require("otplib");
const pool = require("../config/db");
const redis = require("../config/redis");
const { verifyLogin } = require("../middleware/auth");

// Direct, reliable extraction of the authenticator instance
const authenticator = otplib.authenticator || otplib;

// Helper to reliably extract boolean validation status across otplib version formats
async function verifyTotpToken(token, secret) {
  try {
    const cleanToken = String(token).trim();
    const cleanSecret = String(secret).trim();

    // Call verify or check
    let res = authenticator.verify
      ? authenticator.verify({ token: cleanToken, secret: cleanSecret })
      : authenticator.check(cleanToken, cleanSecret);

    // Resolve Promise if returned
    if (res && typeof res.then === "function") {
      res = await res;
    }

    // Unpack { valid: true/false } object if returned
    if (typeof res === "object" && res !== null) {
      return Boolean(res.valid);
    }

    return Boolean(res);
  } catch (err) {
    console.error("TOTP Verification Internal Exception:", err);
    return false;
  }
}

// REGISTRATION: Customer Registration
router.post("/register", async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).send("Username and password are required.");
  }

  const cleanUsername = String(username).trim();
  if (cleanUsername.length < 3) {
    return res.status(400).send("Username must be at least 3 characters long.");
  }

  if (String(password).length < 3) {
    return res.status(400).send("Password must be at least 3 characters long.");
  }

  try {
    // Check if username already exists in customers
    const existingUser = await pool.query(
      "SELECT id FROM customers WHERE LOWER(username) = LOWER($1)",
      [cleanUsername],
    );

    if (existingUser.rowCount > 0) {
      return res
        .status(409)
        .send("Username is already taken. Please choose another.");
    }

    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(password, saltRounds);

    await pool.query(
      "INSERT INTO customers (username, password, balance, two_factor_enabled) VALUES ($1, $2, $3, $4)",
      [cleanUsername, hashedPassword, 1000.0, false],
    );

    return res.status(201).send("Customer registered successfully.");
  } catch (error) {
    console.error("Customer registration error:", error);
    return res
      .status(500)
      .send("An error occurred while creating the account.");
  }
});

// STAGE 1: Check Username Existence & Account Lock Status under a Specific Role
router.post("/login/check-user", async (req, res) => {
  const { username, role } = req.body;
  if (!username || !role)
    return res.status(400).send("Username and role type required.");

  const tableMapping = {
    customer: "customers",
    employee: "employees",
    admin: "admins",
  };

  const targetTable = tableMapping[role];
  if (!targetTable)
    return res.status(400).send("Invalid account role context.");

  try {
    const isLocked = await redis.get(`lockout:${role}:${username}`);
    if (isLocked) {
      return res
        .status(423)
        .send("Account is temporarily locked. Try again later.");
    }

    const result = await pool.query(
      `SELECT username FROM ${targetTable} WHERE username = $1`,
      [username],
    );

    if (result.rowCount === 0) {
      return res.status(404).send(`Username not found under ${role} profiles.`);
    }

    res.status(200).json({ status: "valid" });
  } catch (error) {
    console.error("User check error:", error);
    res.status(500).send("Server error");
  }
});

// STAGE 2: Validate Password Credentials within Specified Role Scope
router.post("/login/verify-password", async (req, res) => {
  const { username, password, role } = req.body;
  if (!username || !password || !role)
    return res.status(400).send("Missing elements.");

  const tableMapping = {
    customer: "customers",
    employee: "employees",
    admin: "admins",
  };

  const targetTable = tableMapping[role];
  if (!targetTable)
    return res.status(400).send("Invalid account role context.");

  try {
    const isLocked = await redis.get(`lockout:${role}:${username}`);
    if (isLocked) return res.status(423).send("Account is locked.");

    const result = await pool.query(
      `SELECT * FROM ${targetTable} WHERE username = $1`,
      [username],
    );

    if (result.rowCount === 0)
      return res.status(401).send("Authentication credentials failed.");
    const user = result.rows[0];

    const isValid = await bcrypt.compare(password, user.password);

    if (!isValid) {
      const attemptsKey = `attempts:${role}:${username}`;
      const currentAttempts = await redis.incr(attemptsKey);

      if (currentAttempts === 1) await redis.expire(attemptsKey, 600);

      if (currentAttempts >= 5) {
        await redis.set(`lockout:${role}:${username}`, "true", { ex: 900 });
        await redis.del(attemptsKey);
        return res
          .status(423)
          .send("Maximum attempts exceeded. Account locked for 15 minutes.");
      }

      return res
        .status(401)
        .send(
          `Incorrect credentials. ${5 - currentAttempts} chances remaining.`,
        );
    }

    await redis.del(`attempts:${role}:${username}`);

    if (user.two_factor_enabled && user.two_factor_secret) {
      await redis.set(
        `pending-2fa:${role}:${username}`,
        JSON.stringify({
          id: user.id,
          username: user.username,
          userType: role,
        }),
        { ex: 300 },
      );
      return res.status(200).json({ step: "2fa_required" });
    }

    req.session.user = {
      id: user.id,
      username: user.username,
      userType: role,
    };
    return res.status(200).json({ step: "completed", userType: role });
  } catch (error) {
    console.error("Password verify error:", error);
    res.status(500).send("Server error");
  }
});

// STAGE 3: Verify the 6-digit 2FA token code within Role context
router.post("/login/verify-2fa", async (req, res) => {
  const { username, token, role } = req.body;
  if (!username || !token || !role)
    return res.status(400).send("Missing processing parameters.");

  const tableMapping = {
    customer: "customers",
    employee: "employees",
    admin: "admins",
  };

  const targetTable = tableMapping[role];

  try {
    const pendingData = await redis.get(`pending-2fa:${role}:${username}`);
    if (!pendingData) {
      return res
        .status(400)
        .send("Session expired. Please enter password again.");
    }

    const parsedUser =
      typeof pendingData === "string" ? JSON.parse(pendingData) : pendingData;

    const dbResult = await pool.query(
      `SELECT two_factor_secret FROM ${targetTable} WHERE id = $1`,
      [parsedUser.id],
    );

    if (dbResult.rowCount === 0)
      return res.status(404).send("User match database lookup error.");

    const secret = dbResult.rows[0].two_factor_secret;
    if (!secret) {
      return res.status(400).send("2FA secret not configured for account.");
    }

    // Verify token using robust handler
    const isVerified = await verifyTotpToken(token, secret);

    console.log("--- 2FA DEBUG CHECK ---");
    console.log("Submitted Token:", token);
    console.log("DB Secret:", secret);
    console.log("Is Verified Result:", isVerified);
    console.log("-----------------------");

    if (!isVerified) {
      return res.status(401).send("Invalid 2FA token code.");
    }

    req.session.user = {
      id: parsedUser.id,
      username: parsedUser.username,
      userType: parsedUser.userType,
    };
    await redis.del(`pending-2fa:${role}:${username}`);

    return res
      .status(200)
      .json({ status: "success", userType: parsedUser.userType });
  } catch (error) {
    console.error("2FA verification crash:", error);
    return res.status(500).send("Server token matching verification failure.");
  }
});

// STAGE 4: Generate 2FA Secret & QR Code for User Setup
router.get("/2fa/setup", verifyLogin, async (req, res) => {
  try {
    if (!req.session || !req.session.user) {
      return res.status(401).send("Unauthorized. Session not found.");
    }

    const { id, username, userType } = req.session.user;

    if (!id || !username || !userType) {
      return res.status(400).send("Invalid session profile details.");
    }

    // Generate secret
    const secret = authenticator.generateSecret();

    // Safe keyuri execution
    const getKeyuri = authenticator.keyuri || otplib.keyuri;
    const otpauth =
      typeof getKeyuri === "function"
        ? getKeyuri(username, "Bank of Vellorian", secret)
        : `otpauth://totp/Bank%20of%20Vellorian:${username}?secret=${secret}&issuer=Bank%20of%20Vellorian`;

    // Render QR Code as Data URL
    const qrCodeUrl = await qrcode.toDataURL(otpauth);

    // Save secret to Upstash Redis
    await redis.set(`setup-2fa:${userType}:${id}`, String(secret), { ex: 600 });

    return res.status(200).json({
      qrCodeUrl,
      secret,
    });
  } catch (error) {
    console.error("2FA Setup Route Failure:", error);
    return res
      .status(500)
      .send(`Failed to generate 2FA setup details: ${error.message}`);
  }
});

// STAGE 5: Confirm and Enable 2FA
router.post("/2fa/enable", verifyLogin, async (req, res) => {
  const { token } = req.body;
  const { id, userType } = req.session.user;

  if (!token) return res.status(400).send("6-digit token code required.");

  const tableMapping = {
    customer: "customers",
    employee: "employees",
    admin: "admins",
  };

  const targetTable = tableMapping[userType];

  try {
    const secret = await redis.get(`setup-2fa:${userType}:${id}`);
    if (!secret) {
      return res
        .status(400)
        .send("2FA setup session expired. Please try setup again.");
    }

    const isValid = await verifyTotpToken(token, secret);

    if (!isValid) {
      return res.status(400).send("Invalid 2FA token code. Please try again.");
    }

    await pool.query(
      `UPDATE ${targetTable} SET two_factor_secret = $1, two_factor_enabled = TRUE WHERE id = $2`,
      [secret, id],
    );

    await redis.del(`setup-2fa:${userType}:${id}`);

    res.status(200).send("Two-Factor Authentication enabled successfully!");
  } catch (error) {
    console.error("2FA Enable Error:", error);
    res.status(500).send("Failed to enable 2FA.");
  }
});

// STAGE 6: Disable 2FA
router.post("/2fa/disable", verifyLogin, async (req, res) => {
  const { token } = req.body;
  const { id, userType } = req.session.user;

  const tableMapping = {
    customer: "customers",
    employee: "employees",
    admin: "admins",
  };

  const targetTable = tableMapping[userType];

  try {
    const result = await pool.query(
      `SELECT two_factor_secret, two_factor_enabled FROM ${targetTable} WHERE id = $1`,
      [id],
    );

    if (result.rowCount === 0 || !result.rows[0].two_factor_enabled) {
      return res
        .status(400)
        .send("2FA is not currently enabled for this account.");
    }

    const secret = result.rows[0].two_factor_secret;
    const isValid = await verifyTotpToken(token, secret);

    if (!isValid) {
      return res.status(400).send("Invalid 2FA token code.");
    }

    await pool.query(
      `UPDATE ${targetTable} SET two_factor_secret = NULL, two_factor_enabled = FALSE WHERE id = $1`,
      [id],
    );

    res.status(200).send("2FA has been disabled.");
  } catch (error) {
    console.error("2FA Disable Error:", error);
    res.status(500).send("Failed to disable 2FA.");
  }
});

// UNIVERSAL LOGOUT ROUTE
router.post("/logout", (req, res) => {
  if (req.session) {
    req.session.destroy((err) => {
      if (err) return res.status(500).send("Failed to log out cleanly.");
      res.clearCookie("connect.sid");
      return res.status(200).send("Logged out successfully");
    });
  } else {
    res.status(200).send("No active session.");
  }
});

module.exports = router;
