const { Schema, model } = require('mongoose');
const bcrypt = require('bcrypt');

const userSchema = new Schema(
  {
    username: {
      type: String,
      required: true,
      unique: true,
      trim: true
    },
    email: {
      type: String,
      required: true,
      unique: true,
      match: [/.+@.+\..+/, 'Must match an email address!']
    },
    password: {
      type: String,
      required: true,
      minlength: 5
    },
    isAdmin: { // Field to identify admins
      type: Boolean,
      default: false
  },
    classes: [
      {
        type: Schema.Types.ObjectId,
        ref: 'Booking'
      }
    ],
    openPlayPunches: { type: Number, default: 0 },
    membershipExpiry: { type: Date },

    // --- New Stripe Fields ---
    stripeCustomerId: {
      type: String,
      // unique: true, // Might cause issues if creation fails partway, index is better
      index: true,
      sparse: true // Index only if the field exists
    },
    // Store active subscription IDs - could be an array if multiple subs are possible
    stripeSubscriptionId: {
        type: String,
        index: true,
        sparse: true
    },
    // --- Modified/New Installment Tracking Fields ---
    playgroupInstallmentAmount: { // Base amount per installment (cents)
      type: Number
  },
  playgroupInstallmentsRemaining: { // Counter for pending installments
      type: Number
  },
    playgroupEnrollmentSemester: { // Optional: Store which semester this applies to
        type: String // e.g., "fall_2024"
    },
    // Flag to prevent creating bookings multiple times
    playgroupBookingsCreatedForSub: {
        type: String // Store the subscription ID for which bookings were made
    },
    playgroupTotalSemesterCost: { // Total cost calculated at checkout (cents)
      type: Number
  },
  playgroupTotalInstallments: { // Original number of installments calculated
      type: Number
  }
  },
  {
    toJSON: {
      virtuals: true
    }
  }
);

// set up pre-save middleware to create password
userSchema.pre('save', async function(next) {
  if (this.isNew || this.isModified('password')) {
    const saltRounds = 10;
    this.password = await bcrypt.hash(this.password, saltRounds);
  }

  next();
});

// compare the incoming password with the hashed password
userSchema.methods.isCorrectPassword = async function(password) {
  return bcrypt.compare(password, this.password);
};

const User = model('User', userSchema);

module.exports = User;
