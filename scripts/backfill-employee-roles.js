/**
 * backfill-employee-roles.js
 *
 * One-time script to fix existing Employee documents whose `role` field
 * (a legacy duplicate of the authoritative User.role) drifted to the
 * schema default ('employee') because nothing was writing to it before
 * this fix.
 *
 * Run this ONCE per tenant database after deploying the updated
 * employeeController.js. Safe to re-run — it only touches documents
 * where the two roles actually differ.
 *
 * USAGE:
 *   node backfill-employee-roles.js <mongoUri>
 *
 * If your app uses per-tenant DB connections, run this once against each
 * tenant's connection string.
 */

const mongoose = require('mongoose');

const mongoUri = process.argv[2];

if (!mongoUri) {
  console.error('Usage: node backfill-employee-roles.js <mongoUri>');
  process.exit(1);
}

// Minimal schemas — only the fields we need, to avoid pulling in the
// full app's model registration/hooks for this one-off script.
const userSchema = new mongoose.Schema({
  role: String,
  employee: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee' },
}, { strict: false });

const employeeSchema = new mongoose.Schema({
  name: String,
  role: String,
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { strict: false });

async function run() {
  await mongoose.connect(mongoUri);
  console.log('Connected to', mongoUri.replace(/\/\/.*@/, '//<redacted>@'));

  const User = mongoose.model('User', userSchema);
  const Employee = mongoose.model('Employee', employeeSchema);

  const employees = await Employee.find({}).populate('user', 'role');

  let fixed = 0;
  let skippedNoUser = 0;
  let alreadyCorrect = 0;

  for (const emp of employees) {
    if (!emp.user || !emp.user.role) {
      skippedNoUser++;
      console.log(`⚠️  ${emp.name || emp._id}: no linked User (or User has no role) — skipped`);
      continue;
    }

    if (emp.role === emp.user.role) {
      alreadyCorrect++;
      continue;
    }

    const oldRole = emp.role;
    emp.role = emp.user.role;
    await emp.save();
    fixed++;
    console.log(`✅ ${emp.name || emp._id}: "${oldRole}" -> "${emp.role}"`);
  }

  console.log('\n--- Summary ---');
  console.log(`Total employees checked: ${employees.length}`);
  console.log(`Fixed:                   ${fixed}`);
  console.log(`Already correct:         ${alreadyCorrect}`);
  console.log(`Skipped (no linked user):${skippedNoUser}`);

  await mongoose.disconnect();
  process.exit(0);
}

run().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});