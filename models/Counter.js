const mongoose = require('mongoose');

const counterSchema = new mongoose.Schema({
  _id: { type: String, required: true },  // e.g. "employeeId_2026"
  seq: { type: Number, default: 0 }
});

module.exports = counterSchema;
