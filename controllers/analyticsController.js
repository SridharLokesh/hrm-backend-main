const mongoose = require('mongoose');
const { getSuperAdminModels, connectTenantDB, getTenantModels } = require('../config/db');

// Get main models helper
const getMainModels = () => {
  return getSuperAdminModels();
};

// @desc    Get super admin analytics overview
// @route   GET /api/super-admin/analytics/overview
// @access  Private/SuperAdmin
exports.getAnalyticsOverview = async (req, res) => {
  try {
    const { Tenant } = getMainModels();

    // Total tenants and status breakdown
    const totalTenants = await Tenant.countDocuments();
    const activeTenants = await Tenant.countDocuments({ isActive: true });
    const inactiveTenants = await Tenant.countDocuments({ isActive: false });
    
    // Subscription plan breakdown
    const planStats = await Tenant.aggregate([
      {
        $group: {
          _id: '$subscription.plan',
          count: { $sum: 1 }
        }
      }
    ]);

    // Industry breakdown
    const industryStats = await Tenant.aggregate([
      {
        $group: {
          _id: '$industry',
          count: { $sum: 1 }
        }
      },
      { $sort: { count: -1 } },
      { $limit: 10 }
    ]);

    // Company size breakdown
    const sizeStats = await Tenant.aggregate([
      {
        $group: {
          _id: '$size',
          count: { $sum: 1 }
        }
      }
    ]);

    res.json({
      success: true,
      data: {
        totalTenants,
        activeTenants,
        inactiveTenants,
        planStats,
        industryStats,
        sizeStats
      }
    });
  } catch (error) {
    console.error('Analytics overview error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to load analytics overview'
    });
  }
};

// @desc    Get tenant growth over time
// @route   GET /api/super-admin/analytics/tenants-growth
// @access  Private/SuperAdmin
exports.getTenantsGrowth = async (req, res) => {
  try {
    const { Tenant } = getMainModels();
    const { period = 'monthly' } = req.query;

    let groupFormat;
    if (period === 'daily') {
      groupFormat = { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } };
    } else if (period === 'weekly') {
      groupFormat = { $dateToString: { format: '%Y-%U', date: '$createdAt' } };
    } else {
      groupFormat = { $dateToString: { format: '%Y-%m', date: '$createdAt' } };
    }

    const growthData = await Tenant.aggregate([
      {
        $group: {
          _id: groupFormat,
          count: { $sum: 1 },
          activeCount: {
            $sum: { $cond: [{ $eq: ['$isActive', true] }, 1, 0] }
          }
        }
      },
      { $sort: { _id: 1 } },
      { $limit: 12 }
    ]);

    // Calculate cumulative growth
    let cumulative = 0;
    const growthWithCumulative = growthData.map(item => {
      cumulative += item.count;
      return {
        period: item._id,
        newTenants: item.count,
        activeTenants: item.activeCount,
        cumulativeTenants: cumulative
      };
    });

    res.json({
      success: true,
      data: growthWithCumulative
    });
  } catch (error) {
    console.error('Tenants growth analytics error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to load tenants growth data'
    });
  }
};

// @desc    Get top companies by employee count
// @route   GET /api/super-admin/analytics/top-companies
// @access  Private/SuperAdmin
exports.getTopCompanies = async (req, res) => {
  try {
    const { Tenant } = getMainModels();
    const { limit = 5 } = req.query;

    const tenants = await Tenant.find({ isActive: true })
      .select('name companyName subdomain industry size employeeCount')
      .sort({ employeeCount: -1 })
      .limit(parseInt(limit));

    // Get employee counts for each tenant
    const companiesWithEmployeeCount = await Promise.all(
      tenants.map(async (tenant) => {
        try {
          const tenantConnection = await connectTenantDB(tenant._id.toString(), tenant.companyName);
          const models = await getTenantModels(tenantConnection);
          const employeeCount = await models.Employee.countDocuments({ isActive: true });
          
          return {
            _id: tenant._id,
            name: tenant.name,
            companyName: tenant.companyName,
            subdomain: tenant.subdomain,
            industry: tenant.industry,
            size: tenant.size,
            employeeCount: employeeCount
          };
        } catch (error) {
          console.error(`Error getting employee count for tenant ${tenant.companyName}:`, error);
          return {
            ...tenant.toObject(),
            employeeCount: 0
          };
        }
      })
    );

    // Sort by employee count
    companiesWithEmployeeCount.sort((a, b) => b.employeeCount - a.employeeCount);

    res.json({
      success: true,
      data: companiesWithEmployeeCount.slice(0, parseInt(limit))
    });
  } catch (error) {
    console.error('Top companies analytics error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to load top companies data'
    });
  }
};

// @desc    Get daily active employees
// @route   GET /api/super-admin/analytics/daily-active-users
// @access  Private/SuperAdmin
exports.getDailyActiveUsers = async (req, res) => {
  try {
    const { Tenant } = getMainModels();
    const { days = 7 } = req.query;

    const activeTenants = await Tenant.find({ isActive: true }).select('_id companyName');

    const dailyActiveData = [];
    const today = new Date();
    
    for (let i = parseInt(days) - 1; i >= 0; i--) {
      const date = new Date(today);
      date.setDate(date.getDate() - i);
      const dateString = date.toISOString().split('T')[0];

      let totalActiveEmployees = 0;
      let tenantsWithActivity = 0;

      // For each tenant, check attendance for that day
      for (const tenant of activeTenants) {
        try {
          const tenantConnection = await connectTenantDB(tenant._id.toString(), tenant.companyName);
          const models = await getTenantModels(tenantConnection);
          
          const activeEmployees = await models.Attendance.countDocuments({
            date: {
              $gte: new Date(dateString + 'T00:00:00.000Z'),
              $lte: new Date(dateString + 'T23:59:59.999Z')
            }
          });

          if (activeEmployees > 0) {
            tenantsWithActivity++;
            totalActiveEmployees += activeEmployees;
          }
        } catch (error) {
          console.error(`Error getting daily active for tenant ${tenant.companyName}:`, error);
          continue;
        }
      }

      dailyActiveData.push({
        date: dateString,
        activeEmployees: totalActiveEmployees,
        activeTenants: tenantsWithActivity
      });
    }

    res.json({
      success: true,
      data: dailyActiveData
    });
  } catch (error) {
    console.error('Daily active users analytics error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to load daily active users data'
    });
  }
};

// @desc    Get attendance rate comparison
// @route   GET /api/super-admin/analytics/attendance-rates
// @access  Private/SuperAdmin
exports.getAttendanceRates = async (req, res) => {
  try {
    const { Tenant } = getMainModels();
    const { period = 'month' } = req.query;

    const activeTenants = await Tenant.find({ isActive: true })
      .select('_id companyName industry size')
      .limit(20); // Limit to prevent too many database connections

    const attendanceRates = [];

    for (const tenant of activeTenants) {
      try {
        const tenantConnection = await connectTenantDB(tenant._id.toString(), tenant.companyName);
        const models = await getTenantModels(tenantConnection);
        
        // Get total employees
        const totalEmployees = await models.Employee.countDocuments({ isActive: true });
        if (totalEmployees === 0) continue;

        // Calculate date range based on period
        const startDate = new Date();
        if (period === 'week') {
          startDate.setDate(startDate.getDate() - 7);
        } else if (period === 'month') {
          startDate.setMonth(startDate.getMonth() - 1);
        } else {
          startDate.setMonth(startDate.getMonth() - 3);
        }

        // Get attendance records in period
        const attendanceRecords = await models.Attendance.countDocuments({
          date: { $gte: startDate }
        });

        // Calculate attendance rate
        const workingDays = period === 'week' ? 5 : period === 'month' ? 22 : 66;
        const expectedAttendance = totalEmployees * workingDays;
        const attendanceRate = expectedAttendance > 0 
          ? (attendanceRecords / expectedAttendance) * 100 
          : 0;

        attendanceRates.push({
          tenantId: tenant._id,
          companyName: tenant.companyName,
          industry: tenant.industry,
          size: tenant.size,
          totalEmployees,
          attendanceRecords,
          attendanceRate: Math.round(attendanceRate * 100) / 100,
          period
        });
      } catch (error) {
        console.error(`Error getting attendance for tenant ${tenant.companyName}:`, error);
        continue;
      }
    }

    // Sort by attendance rate descending
    attendanceRates.sort((a, b) => b.attendanceRate - a.attendanceRate);

    res.json({
      success: true,
      data: attendanceRates
    });
  } catch (error) {
    console.error('Attendance rates analytics error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to load attendance rates data'
    });
  }
};

// @desc    Get comprehensive analytics dashboard
// @route   GET /api/super-admin/analytics/dashboard
// @access  Private/SuperAdmin
exports.getDashboardAnalytics = async (req, res) => {
  try {
    // Create mock response objects to avoid circular dependencies
    const mockRes = (data) => ({
      json: () => data
    });

    // Call each function directly instead of using exports
    const overview = await exports.getAnalyticsOverview(req, mockRes({ data: {} }));
    const growth = await exports.getTenantsGrowth(req, mockRes({ data: {} }));
    const topCompanies = await exports.getTopCompanies({ ...req, query: { limit: 5 } }, mockRes({ data: {} }));
    const dailyActive = await exports.getDailyActiveUsers({ ...req, query: { days: 7 } }, mockRes({ data: {} }));
    const attendanceRates = await exports.getAttendanceRates({ ...req, query: { period: 'month' } }, mockRes({ data: {} }));

    res.json({
      success: true,
      data: {
        overview: overview?.data || {},
        growth: growth?.data || {},
        topCompanies: topCompanies?.data || [],
        dailyActive: dailyActive?.data || [],
        attendanceRates: attendanceRates?.data || []
      }
    });
  } catch (error) {
    console.error('Dashboard analytics error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to load dashboard analytics'
    });
  }
};

const moment = require('moment');

// Helper to resolve models
const resolveModel = (req, name, defaultSchema) => {
  if (req.models && req.models[name]) return req.models[name];
  const schema = defaultSchema && defaultSchema.schema ? defaultSchema.schema : defaultSchema;
  if (mongoose.models && mongoose.models[name]) return mongoose.models[name];
  return mongoose.model(name, schema);
};

// @desc    Get comprehensive analytics for dashboard
// @route   GET /api/analytics/dashboard
// @access  Private/Admin
exports.getAnalyticsDashboard = async (req, res) => {
  try {
    const Employee = resolveModel(req, 'Employee', require('../models/Employee'));
    const Attendance = resolveModel(req, 'Attendance', require('../models/Attendance'));
const Project = resolveModel(req, 'Project', require('../models/Project'));
    const Task = resolveModel(req, 'Task', require('../models/Task'));
    const Permission = resolveModel(req, 'Permission', require('../models/Permission'));

    // 1. EMPLOYEE ATTENDANCE RATE ANALYTICS
    const totalEmployees = await Employee.countDocuments({ isActive: true });
    
    // Monthly attendance trend (last 6 months)
    const sixMonthsAgo = moment().subtract(5, 'months').startOf('month');
    const monthlyAttendance = await Attendance.aggregate([
      {
        $match: {
          date: {
            $gte: sixMonthsAgo.toDate(),
            $lte: moment().endOf('month').toDate()
          }
        }
      },
      {
        $group: {
          _id: {
            month: { $month: '$date' },
            year: { $year: '$date' }
          },
          presentCount: {
            $sum: {
              $cond: [
                { $in: ['$status', ['present', 'present-with-permission']] },
                1, 0
              ]
            }
          },
          totalCount: { $sum: 1 },
          uniqueEmployees: { $addToSet: '$employee' }
        }
      },
      { $sort: { '_id.year': 1, '_id.month': 1 } }
    ]);

    // Calculate monthly attendance percentage relative to tenant total employees
    const attendanceRates = monthlyAttendance.map(item => {
      const monthYear = `${item._id.year}-${item._id.month.toString().padStart(2, '0')}`;
      const monthName = moment(`${item._id.year}-${item._id.month}`, 'YYYY-M').format('MMM YYYY');
      const daysInMonth = moment(`${item._id.year}-${item._id.month}`, 'YYYY-M').daysInMonth();
      const presentCount = item.presentCount || 0;
      const attendanceRate = totalEmployees > 0 ? (presentCount / (totalEmployees * daysInMonth)) * 100 : 0;

      return {
        period: monthYear,
        label: monthName,
        attendanceRate: Math.round(attendanceRate * 100) / 100,
        presentCount: presentCount,
        totalEmployees: totalEmployees
      };
    });

    // Current month attendance rate
    const currentMonthStart = moment().startOf('month');
    const currentMonthEnd = moment().endOf('month');
    const currentMonthAttendance = await Attendance.aggregate([
      {
        $match: {
          date: {
            $gte: currentMonthStart.toDate(),
            $lte: currentMonthEnd.toDate()
          }
        }
      },
      {
        $group: {
          _id: null,
          presentCount: {
            $sum: {
              $cond: [
                { $in: ['$status', ['present', 'present-with-permission']] },
                1, 0
              ]
            }
          },
          uniqueEmployees: { $addToSet: '$employee' }
        }
      }
    ]);

    // Compute current month attendance percentage relative to total employees and days elapsed
    const daysSoFar = moment().date(); // day of month (1..31)
    const currentMonthPresent = (currentMonthAttendance.length > 0 && currentMonthAttendance[0].presentCount) ? currentMonthAttendance[0].presentCount : 0;
    const currentMonthRate = totalEmployees > 0 && daysSoFar > 0 ?
      (currentMonthPresent / (totalEmployees * daysSoFar)) * 100 : 0;

    // 1.a DAILY ATTENDANCE DATA (Last 30 days)
    const thirtyDaysAgo = moment().subtract(29, 'days').startOf('day');
    const dailyAttendance = await Attendance.aggregate([
      {
        $match: {
          date: {
            $gte: thirtyDaysAgo.toDate(),
            $lte: moment().endOf('day').toDate()
          }
        }
      },
      {
        $group: {
          _id: {
            date: { $dateToString: { format: '%Y-%m-%d', date: '$date' } }
          },
          presentCount: {
            $sum: {
              $cond: [
                { $in: ['$status', ['present', 'present-with-permission']] },
                1, 0
              ]
            }
          },
          uniqueEmployees: { $addToSet: '$employee' }
        }
      },
      { $sort: { '_id.date': 1 } }
    ]);

    // Format daily data
    const dailyData = [];
    for (let i = 29; i >= 0; i--) {
      const date = moment().subtract(i, 'days').format('YYYY-MM-DD');
      const dayName = moment().subtract(i, 'days').format('DD MMM');
      const dayData = dailyAttendance.find(d => d._id.date === date);
      
      const presentCount = dayData?.presentCount || 0;
      // Use tenant totalEmployees as the denominator for daily attendance percentage
      const employeeCount = totalEmployees;
      const attendanceRate = employeeCount > 0 ? (presentCount / employeeCount) * 100 : 0;

      dailyData.push({
        date: dayName,
        fullDate: date,
        presentCount,
        totalEmployees: employeeCount,
        attendanceRate: Math.round(attendanceRate * 100) / 100
      });
    }

    // Current day data (today)
    const todayData = dailyData[dailyData.length - 1] || {};

    // 2. PROJECT TASK PERFORMANCE ANALYTICS
    const projects = await Project.find({ isActive: true })
      .populate('assignedEmployees', 'name')
      .select('name progress status startDate endDate assignedEmployees');

    const projectPerformance = await Promise.all(
      projects.map(async (project) => {
        const taskStats = await Task.aggregate([
          { $match: { project: project._id } },
          {
            $group: {
              _id: '$status',
              count: { $sum: 1 },
              totalHours: { $sum: '$estimatedHours' }
            }
          }
        ]);

        const statusCounts = {
          todo: 0,
          'in-progress': 0,
          review: 0,
          done: 0
        };

        taskStats.forEach(stat => {
          statusCounts[stat._id] = stat.count;
        });

        const totalTasks = Object.values(statusCounts).reduce((sum, count) => sum + count, 0);
        const completionRate = totalTasks > 0 ? (statusCounts.done / totalTasks) * 100 : 0;

        // Project health calculation
        const now = new Date();
        const totalDuration = project.endDate - project.startDate;
        const elapsedDuration = now - project.startDate;
        const timeProgress = totalDuration > 0 ? (elapsedDuration / totalDuration) * 100 : 0;
        
        const healthScore = timeProgress > 0 ? 
          Math.min((project.progress / timeProgress) * 100, 100) : 
          project.progress;

        return {
          projectId: project._id,
          name: project.name,
          progress: project.progress,
          status: project.status,
          assignedEmployees: project.assignedEmployees.length,
          taskStats: statusCounts,
          totalTasks,
          completionRate: Math.round(completionRate * 100) / 100,
          healthScore: Math.round(healthScore * 100) / 100,
          isOnTrack: healthScore >= 80 ? 'good' : healthScore >= 60 ? 'warning' : 'critical'
        };
      })
    );

    // Overall project statistics
    const totalProjects = projectPerformance.length;
    const avgProjectCompletion = totalProjects > 0 ? 
      projectPerformance.reduce((sum, project) => sum + project.completionRate, 0) / totalProjects : 0;
    
    const onTrackProjects = projectPerformance.filter(p => p.isOnTrack === 'good').length;

    // 3. DEPARTMENT-WISE EMPLOYEE ANALYTICS
    const departmentStats = await Employee.aggregate([
      { $match: { isActive: true } },
      {
        $group: {
          _id: '$department',
          employeeCount: { $sum: 1 },
          avgSalary: { $avg: '$salary' },
          employees: { $push: '$$ROOT' }
        }
      },
      { $sort: { employeeCount: -1 } }
    ]);

    const departmentAnalytics = await Promise.all(
      departmentStats.map(async (dept) => {
        const employeeIds = dept.employees.map(emp => emp._id);
        
        // Get recent attendance for this department (last 30 days)
        const thirtyDaysAgo = moment().subtract(30, 'days').toDate();
        const attendanceStats = await Attendance.aggregate([
          {
            $match: {
              employee: { $in: employeeIds },
              date: { $gte: thirtyDaysAgo }
            }
          },
          {
            $group: {
              _id: '$employee',
              presentDays: {
                $sum: {
                  $cond: [
                    { $in: ['$status', ['present', 'present-with-permission']] },
                    1, 0
                  ]
                }
              },
              totalDays: { $sum: 1 }
            }
          }
        ]);

        // Calculate average attendance rate for department
        let totalAttendanceRate = 0;
        let employeesWithAttendance = 0;

        attendanceStats.forEach(stat => {
          if (stat.totalDays > 0) {
            const employeeRate = (stat.presentDays / stat.totalDays) * 100;
            totalAttendanceRate += employeeRate;
            employeesWithAttendance++;
          }
        });

        const avgAttendanceRate = employeesWithAttendance > 0 ? 
          totalAttendanceRate / employeesWithAttendance : 0;

        // Gender distribution
        const genderDistribution = {
          male: dept.employees.filter(emp => emp.gender === 'male').length,
          female: dept.employees.filter(emp => emp.gender === 'female').length,
          other: dept.employees.filter(emp => emp.gender === 'other' || !emp.gender).length
        };

        return {
          department: dept._id,
          employeeCount: dept.employeeCount,
          avgSalary: Math.round(dept.avgSalary),
          avgAttendanceRate: Math.round(avgAttendanceRate * 100) / 100,
          genderDistribution,
          teamStrength: dept.employeeCount < 5 ? 'small' : 
                       dept.employeeCount < 15 ? 'medium' : 'large'
        };
      })
    );

    // Overall company statistics
    const overallAvgSalary = totalEmployees > 0 ? 
      departmentAnalytics.reduce((sum, dept) => sum + (dept.avgSalary * dept.employeeCount), 0) / totalEmployees : 0;

    res.json({
      success: true,
      data: {
        // Attendance Analytics
        attendance: {
          currentRate: todayData.attendanceRate || Math.round(currentMonthRate * 100) / 100,
          monthlyTrend: attendanceRates,
          dailyData: dailyData,
          today: todayData,
          totalEmployees,
          summary: {
            excellent: attendanceRates.filter(r => r.attendanceRate >= 90).length,
            good: attendanceRates.filter(r => r.attendanceRate >= 75 && r.attendanceRate < 90).length,
            needsImprovement: attendanceRates.filter(r => r.attendanceRate < 75).length
          }
        },

        // Project Performance Analytics
        projects: {
          totalProjects,
          avgCompletionRate: Math.round(avgProjectCompletion * 100) / 100,
          onTrackProjects,
          projectPerformance: projectPerformance.slice(0, 10), // Top 10 projects
          performanceSummary: {
            good: projectPerformance.filter(p => p.isOnTrack === 'good').length,
            warning: projectPerformance.filter(p => p.isOnTrack === 'warning').length,
            critical: projectPerformance.filter(p => p.isOnTrack === 'critical').length
          }
        },
        
        // Department Analytics
        departments: {
          totalDepartments: departmentAnalytics.length,
          overallAvgSalary: Math.round(overallAvgSalary),
          departmentAnalytics: departmentAnalytics,
          largestDepartment: departmentAnalytics[0] || null,
          departmentDistribution: departmentAnalytics.map(dept => ({
            name: dept.department,
            value: dept.employeeCount,
            attendanceRate: dept.avgAttendanceRate
          }))
        },
        
        // Quick Stats for Cards
        quickStats: {
          totalEmployees,
          totalProjects,
          avgAttendance: Math.round(currentMonthRate * 100) / 100,
          onTrackProjects,
          pendingPermissions: await Permission.countDocuments({ status: 'pending' })
        }
      }
    });
  } catch (error) {
    console.error('Analytics dashboard error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to load analytics dashboard'
    });
  }
};

