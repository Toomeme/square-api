const express = require('express');
const router = express.Router();
const Class = require('../models/Class');

// GET all classes
router.get('/', async (req, res) => {
    try {
        const classes = await Class.find();
        res.json(classes);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// GET a single class by ID
router.get('/:id', async (req, res) => {
    try {
        const classItem = await Class.findById(req.params.id);
        if (!classItem) {
            return res.status(404).json({ message: 'Class not found' });
        }
        res.json(classItem);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// POST create a new class (Admin only - you'll need authentication!)
router.post('/', async (req, res) => {
    const newClass = new Class(req.body);
    try {
        const savedClass = await newClass.save();
        res.status(201).json(savedClass);
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
});

// PUT update a class (Admin only)
router.put('/:id', async (req, res) => {
    try {
        const updatedClass = await Class.findByIdAndUpdate(req.params.id, req.body, { new: true });
        if (!updatedClass) {
            return res.status(404).json({ message: 'Class not found' });
        }
        res.json(updatedClass);
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
});

// DELETE a class (Admin only)
router.delete('/:id', async (req, res) => {
    try {
        const deletedClass = await Class.findByIdAndDelete(req.params.id);
        if (!deletedClass) {
            return res.status(404).json({ message: 'Class not found' });
        }
        res.json({ message: 'Class deleted' });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

module.exports = router;