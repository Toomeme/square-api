// routes/users.js
const express = require('express');
const router = express.Router();
const User = require('../models/User');
const { signToken } = require('../utils/auth');

// --- User Registration ---
router.post('/register', async (req, res) => {
    try {
        const user = await User.create(req.body);
        const token = signToken(user);
        res.json({ token, user });
    } catch (err) {
        console.error(err);
        res.status(400).json({ message: 'Registration failed', error: err.message });
    }
});

// --- User Login ---
router.post('/login', async (req, res) => {
    try {
        const user = await User.findOne({ email: req.body.email });

        if (!user) {
            return res.status(400).json({ message: "Can't find this user" });
        }

        const correctPw = await user.isCorrectPassword(req.body.password);

        if (!correctPw) {
            return res.status(400).json({ message: 'Wrong password!' });
        }

        const token = signToken(user);
        res.json({ token, user });

    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Login failed', error: err.message });
    }
});

module.exports = router;