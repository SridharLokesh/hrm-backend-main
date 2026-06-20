const express = require('express');
const { protect, authorize } = require('../middleware/auth');
const { getTeamStructure, assignTeamMember, removeTeamMember, bulkAssignTeamMembers } = require('../controllers/teamController');
const { requireTenant } = require('../middleware/tenant');

const router = express.Router();

router.use(requireTenant);
router.use(protect);

router.get('/structure', authorize('admin', 'manager', 'team-lead'), getTeamStructure);
router.post('/:teamLeadId/assign/:memberId', authorize('admin', 'manager', 'team-lead'), assignTeamMember);
router.post('/bulk-assign', authorize('admin'), bulkAssignTeamMembers);
router.delete('/:teamLeadId/remove/:memberId', authorize('admin', 'manager', 'team-lead'), removeTeamMember);

module.exports = router;
