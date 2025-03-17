const pricing = require('/utils/pricing'); // Adjust path if needed
router.post('/', async (req, res) => {
    const { serviceType, daysPerWeek, paymentType, openPlayOption, partyDuration, userId, classId } = req.body;

    let costDetails;
    try {
        if (serviceType === 'playgroup') {
            costDetails = pricing.calculatePlayGroupCost(daysPerWeek, paymentType);
        } else if (serviceType === 'openplay') {
            costDetails = pricing.calculateOpenPlayCost(openPlayOption);
        } else if (serviceType === 'birthday') {
            costDetails = pricing.calculateBirthdayPartyCost(partyDuration);
        } else {
            return res.status(400).json({ message: 'Invalid service type' });
        }

        if (costDetails.error) {
            return res.status(400).json({ message: costDetails.error });
        }

        // Create the booking object, including the calculated cost
        const newBooking = new Booking({
            user: userId,
            class: classId, // You might not need a class ID for all service types
            serviceType: serviceType,
            cost: costDetails.totalCost, // Or the relevant cost field
            details: costDetails, // Store the detailed cost breakdown
            // ... other booking fields
        });

        const savedBooking = await newBooking.save();
        res.status(201).json(savedBooking);

    } catch (err) {
        res.status(400).json({ message: err.message });
    }
});