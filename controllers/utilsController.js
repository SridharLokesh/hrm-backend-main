const axios = require('axios');

// GET /api/utils/verify-pincode/:pincode?city=Chennai
exports.verifyPincode = async (req, res) => {
  try {
    const { pincode } = req.params;
    const { city } = req.query;

    if (!/^\d{6}$/.test(pincode)) {
      return res.status(400).json({ success: false, message: 'Pincode must be 6 digits' });
    }

    const response = await axios.get(`https://api.postalpincode.in/pincode/${pincode}`, { timeout: 8000 });
    const result = response.data?.[0];

    if (!result || result.Status !== 'Success' || !Array.isArray(result.PostOffice) || result.PostOffice.length === 0) {
      return res.status(200).json({
        success: true,
        data: { valid: false, matches: false, message: 'Pincode not found' }
      });
    }

    const offices = result.PostOffice;
    const district = offices[0].District;
    const state = offices[0].State;
    const candidateNames = offices.flatMap(o => [o.Name, o.Block, o.District]).filter(Boolean);

    let matches = true;
    if (city && city.trim()) {
      const normalizedCity = city.trim().toLowerCase();
      matches = candidateNames.some(
        name => name.toLowerCase().includes(normalizedCity) || normalizedCity.includes(name.toLowerCase())
      );
    }

    return res.status(200).json({
      success: true,
      data: {
        valid: true,
        matches,
        district,
        state,
        officeNames: candidateNames
      }
    });
  } catch (error) {
    console.error('Pincode verification failed:', error.message);
    return res.status(200).json({
      success: true,
      data: { valid: false, matches: false, message: 'Could not verify pincode right now' }
    });
  }
};