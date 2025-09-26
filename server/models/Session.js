const mongoose = require('mongoose');

/**
 * Defines the schema for a session.
 * This structure will be used for every session document in the MongoDB database.
 */
const sessionSchema = new mongoose.Schema({
  sessionId: {
    type: String,
    required: true,
    unique: true,
    index: true // Improves query performance for finding sessions by ID
  },
  sessionName: {
    type: String,
    required: true
  },
  sessionDate: {
    type: String,
    required: true
  },
  sessionTime: {
    type: String,
    required: true
  },
  pptFileNames: [String],
  status: {
    type: String,
    enum: ["scheduled", "live", "ended"],
    default: "scheduled",
  },
  currentSlide: {
    type: Number,
    default: 1
  },
  slideCount: {
    type: Number,
    default: 0
  },
}, { 
  // Automatically add createdAt and updatedAt timestamps to each document
  timestamps: true 
});

// Create the Mongoose model from the schema
const Session = mongoose.model("Session", sessionSchema);

// Export the model so it can be used by other parts of the server
module.exports = Session;
