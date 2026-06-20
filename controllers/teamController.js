exports.getTeamStructure = async (req, res) => {
  try {
    const Employee = req.models.Employee;
    if (!Employee) {
      return res.status(500).json({ message: 'Employee model not available' });
    }

    const userRole = req.user.role;

    let roots;
    if (userRole === 'admin' || userRole === 'manager') {
      // Admin/Manager sees all root team-leads
    roots = await Employee.find({ 
        isActive: true,
        role: { $in: ['team-lead', 'manager'] }, 
        $or: [{ teamLead: null }, { teamLead: { $exists: false } }]
      }).populate({
        path: 'teamMembers',
        match: { isActive: true },
        populate: { path: 'teamMembers', match: { isActive: true } }
      }).select('_id name email position department teamMembers');
    } else if (userRole === 'team-lead') {
      // Team-lead sees own tree
      const myEmployee = await Employee.findOne({ user: req.user._id });
      if (!myEmployee) {
        return res.status(404).json({ message: 'Team lead employee record not found' });
      }
    roots = [await myEmployee.populate({
        path: 'teamMembers',
        match: { isActive: true },
        populate: { path: 'teamMembers', match: { isActive: true } }
      }).select('_id name email position department teamMembers') ];
    } else {
      return res.status(403).json({ message: 'Access denied for role: ' + userRole });
    }

    res.json(roots);
  } catch (error) {
    console.error('Get team structure error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

const mongoose = require('mongoose');

exports.assignTeamMember = async (req, res) => {
  try {
    const { teamLeadId, memberId } = req.params;
    if (!teamLeadId || !mongoose.Types.ObjectId.isValid(teamLeadId)) {
      return res.status(400).json({ 
        error: 'Invalid teamLeadId', 
        value: teamLeadId,
        message: 'teamLeadId must be a valid MongoDB ObjectId'
      });
    }

    if (!memberId || !mongoose.Types.ObjectId.isValid(memberId)) {
      return res.status(400).json({ 
        error: 'Invalid memberId', 
        value: memberId,
        message: 'memberId must be a valid MongoDB ObjectId'
      });
    }

    const Employee = req.models.Employee;

    const teamLead = await Employee.findById(teamLeadId);
    const member = await Employee.findById(memberId);
    if (!teamLead || !member) {
      return res.status(404).json({ message: 'Team lead or member not found' });
    }
    if (teamLeadId === memberId) {
      return res.status(400).json({ message: 'Cannot assign to self' });
    }
    if (member.teamLead) {
      return res.status(400).json({ message: 'Member already assigned to a team lead' });
    }

    // Bidirectional
    teamLead.teamMembers.push(member._id);
    member.teamLead = teamLead._id;
    await teamLead.save();
    await member.save();

    res.json({ message: 'Member assigned successfully', teamLead, member });
  } catch (error) {
    console.error('Assign team member error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

exports.removeTeamMember = async (req, res) => {
  try {
    const { teamLeadId, memberId } = req.params;
    if (!teamLeadId || !mongoose.Types.ObjectId.isValid(teamLeadId)) {
      return res.status(400).json({ 
        error: 'Invalid teamLeadId', 
        value: teamLeadId,
        message: 'teamLeadId must be a valid MongoDB ObjectId'
      });
    }

    if (!memberId || !mongoose.Types.ObjectId.isValid(memberId)) {
      return res.status(400).json({ 
        error: 'Invalid memberId', 
        value: memberId,
        message: 'memberId must be a valid MongoDB ObjectId'
      });
    }

    const Employee = req.models.Employee;

    const teamLead = await Employee.findById(teamLeadId);
    const member = await Employee.findById(memberId);
    if (!teamLead || !member) {
      return res.status(404).json({ message: 'Team lead or member not found' });
    }

    teamLead.teamMembers.pull(member._id);
    member.teamLead = null;
    await teamLead.save();
    await member.save();

    res.json({ message: 'Member removed successfully', teamLead, member });
  } catch (error) {
    console.error('Remove team member error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// NEW: Bulk assign multiple members to a team lead (admin only)
exports.bulkAssignTeamMembers = async (req, res) => {
  try {
    const { teamLeadId, memberIds } = req.body;
    
    if (!teamLeadId || !mongoose.Types.ObjectId.isValid(teamLeadId)) {
      return res.status(400).json({ 
        error: 'Invalid teamLeadId', 
        message: 'teamLeadId must be a valid MongoDB ObjectId'
      });
    }

    if (!Array.isArray(memberIds) || memberIds.length === 0 || memberIds.length > 50) {
      return res.status(400).json({ 
        error: 'Invalid memberIds', 
        message: 'memberIds must be non-empty array (max 50)' 
      });
    }

    // Validate all memberIds are valid ObjectIds
    const validMemberIds = memberIds.filter(id => mongoose.Types.ObjectId.isValid(id));
    if (validMemberIds.length !== memberIds.length) {
      return res.status(400).json({ 
        error: 'Invalid memberIds', 
        message: 'All memberIds must be valid MongoDB ObjectIds' 
      });
    }

    const Employee = req.models.Employee;

    const teamLead = await Employee.findById(teamLeadId);
    if (!teamLead) {
      return res.status(404).json({ message: 'Team lead not found' });
    }

    const members = await Employee.find({ _id: { $in: memberIds } });
    if (members.length !== memberIds.length) {
      return res.status(404).json({ message: 'Some members not found' });
    }

    const results = { success: 0, failed: [], errors: [] };

    for (const member of members) {
      try {
        if (teamLead._id.toString() === member._id.toString()) {
          results.failed.push({ id: member._id, reason: 'Cannot assign to self' });
          continue;
        }
        if (member.teamLead) {
          results.failed.push({ id: member._id, reason: 'Already assigned' });
          continue;
        }

        // Assign
        teamLead.teamMembers.push(member._id);
        member.teamLead = teamLead._id;
        await teamLead.save();
        await member.save();
        results.success++;
      } catch (err) {
        results.errors.push({ id: member._id, error: err.message });
      }
    }

    res.json({ 
      message: `Bulk assign completed: ${results.success} success, ${results.failed.length + results.errors.length} failed`,
      results 
    });
  } catch (error) {
    console.error('Bulk assign error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};
