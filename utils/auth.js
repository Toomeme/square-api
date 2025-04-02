// utils/auth.js
const jwt = require('jsonwebtoken');

const secret = process.env.JWT_SECRET; //  BEST PRACTICE: Store this in an environment variable!
const expiration = '2h';

module.exports = {
    authMiddleware: function(req, res, next) { // Use regular function definition
        let token = req.body.token || req.query.token || req.headers.authorization;

        if (req.headers.authorization) {
            token = token.split(' ').pop().trim();
        }

        if (!token) {
            // Return 401 and an error message, and call next() with the error
            return res.status(401).json({ message: 'Unauthorized: No token provided' });
        }

        try {
            const { data } = jwt.verify(token, secret, { maxAge: expiration });
            req.user = data;
            next(); // Call next() if verification is successful
        } catch (err) { // Catch the error
            console.error('Invalid token:', err); // Log the error
            return res.status(401).json({ message: 'Unauthorized: Invalid token' });
        }
    },
    signToken: function({ username, email, _id }) {
        const payload = { username, email, _id };
        return jwt.sign({ data: payload }, secret, { expiresIn: expiration });
    }
};