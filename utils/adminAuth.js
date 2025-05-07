// utils/adminAuth.js
const adminCheckMiddleware = (req, res, next) => {
    if (req.session && req.session.userId && req.session.isAdmin) {
        console.log(`Admin access granted via session for user ID: ${req.session.userId}`);
        // Make admin user info available to views if needed
        res.locals.adminUser = { username: req.session.username };
        next();
    } else {
        console.warn(`Admin access denied. Session data:`, req.session);
        if (req.originalUrl.startsWith('/api/admin')) { // For API calls
            return res.status(403).json({ message: 'Forbidden: Admin privileges required.' });
        } else { // For page views
            return res.redirect('/admin/login'); // Redirect to admin login page
        }
    }
};

// Redirect to dashboard if already logged in as admin (for the login page itself)
const redirectIfAdminLoggedIn = (req, res, next) => {
    if (req.session && req.session.userId && req.session.isAdmin) {
        return res.redirect('/admin/dashboard'); // Or just '/admin/' if that's your dashboard
    }
    next();
};

module.exports = { adminCheckMiddleware, redirectIfAdminLoggedIn };