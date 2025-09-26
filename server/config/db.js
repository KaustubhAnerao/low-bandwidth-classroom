const mongoose = require("mongoose");

/**
 * Establishes a connection to the MongoDB database using the connection string
 * from the environment variables.
 */
const connectDB = async () => {
  try {
    // The Mongoose connect method returns a promise, so we await it
    await mongoose.connect(process.env.MONGODB_CONNECTION_STRING);
    console.log("✅ MongoDB connected successfully.");
  } catch (err) {
    // If the connection fails, log the error and exit the application
    console.error("❌ MongoDB connection error:", err.message);
    process.exit(1); // Exit the process with a failure code
  }
};

module.exports = connectDB;
