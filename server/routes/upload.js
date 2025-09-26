const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const poppler = require('pdf-poppler');

// Create a new Express router
const router = express.Router();

// Define the storage configuration for Multer
// This tells Multer where to save the uploaded files and what to name them.
const storage = multer.diskStorage({
  // The destination directory for temporary file storage
  destination: (req, file, cb) => cb(null, 'uploads/'),
  // The filename for the temporarily stored file
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
});

// Initialize Multer with the storage configuration
const upload = multer({ storage: storage });

/**
 * Defines the POST /upload route.
 * This endpoint handles the PDF file upload, converts it to PNG images,
 * and returns the number of slides created.
 *
 * It uses Multer as middleware to process the 'multipart/form-data' request.
 */
router.post('/', upload.single('sessionFile'), async (req, res) => {
  // Check if a file was actually uploaded
  if (!req.file) {
    return res.status(400).json({ success: false, message: 'No file was uploaded.' });
  }

  // Basic validation to ensure the uploaded file is a PDF
  if (path.extname(req.file.originalname).toLowerCase() !== '.pdf') {
    fs.unlinkSync(req.file.path); // Clean up the invalid file
    return res.status(400).json({ success: false, message: 'Only PDF files are allowed.' });
  }

  const { sessionId } = req.body;
  const filePath = req.file.path;
  // Define the output directory based on the session ID
  const outputDir = path.join(__dirname, '..', '..', 'public', 'slides', sessionId);

  // Create the session-specific directory if it doesn't exist
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  try {
    // PDF-to-image conversion options
    const opts = {
      format: 'png',
      out_dir: outputDir,
      out_prefix: 'slide',
      page: null, // Convert all pages
    };

    // Perform the conversion
    await poppler.convert(filePath, opts);

    // Count the number of images created
    const files = fs.readdirSync(outputDir);
    const slideCount = files.filter((f) => f.endsWith('.png')).length;

    // Clean up the temporary PDF file from the 'uploads' directory
    fs.unlinkSync(filePath);

    // Send a success response with the total slide count
    res.json({ success: true, slideCount });
  } catch (err) {
    console.error('❌ PDF conversion error:', err);
    fs.unlinkSync(filePath); // Ensure cleanup even on error
    res.status(500).json({ success: false, message: 'Failed to process the PDF file.' });
  }
});

// Export the router to be used in the main server file
module.exports = router;
