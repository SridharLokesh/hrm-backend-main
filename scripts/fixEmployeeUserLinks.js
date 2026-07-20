/**
 * One-time migration: link Employee.user -> User for employee records that
 * were created BEFORE the createEmployee fix (their `user` field is empty,
 * so role can never populate and always falls back to "employee").
 *
 * Safe to run multiple times — it only touches employees missing a `user` link.
 *
 * Usage (main DB):
 *   node scripts/fixEmployeeUserLinks.js
 *
 * If you run tenant-specific databases, point MONGO_URI at each tenant DB in
 * turn (or adapt this script to loop over your tenant connections) — this
 * script does not know about your tenant-routing middleware, it just needs
 * a working mongoose connection to a DB that has Employee/User collections.
 */

require('dotenv').config();
const mongoose = require('mongoose');
const EmployeeSchema = require('../models/Employee');
const UserSchema = require('../models/User');

async function run() {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error('MONGO_URI is not set. Set it (or edit this script) before running.');
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log('Connected to', uri);

  const Employee = mongoose.models.Employee || mongoose.model('Employee', EmployeeSchema);
  const User = mongoose.models.User || mongoose.model('User', UserSchema);

  const employees = await Employee.find({
    $or: [{ user: { $exists: false } }, { user: null }]
  });

  console.log(`Found ${employees.length} employee(s) missing a linked user.`);

  let fixed = 0;
  let missingUser = 0;

  for (const emp of employees) {
    const user = await User.findOne({ employee: emp._id });
    if (user) {
      emp.user = user._id;
      await emp.save();
      fixed++;
      console.log(`Linked: ${emp.email} -> user ${user._id} (role: ${user.role})`);
    } else {
      missingUser++;
      console.warn(`No matching User found for employee ${emp.email} (${emp._id}) — skipped`);
    }
  }

  console.log(`\nDone. Fixed ${fixed}/${employees.length}. ${missingUser} had no matching User at all.`);
  await mongoose.disconnect();
}

run().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});