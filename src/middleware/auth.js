// File location: src/middleware/auth.js

function verifyLogin(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.status(401).send("Not logged in");
  }
  next();
}

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

module.exports = { verifyLogin, requireRole };
