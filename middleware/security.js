// Essential Security Middleware for RaktMap
// Add this to server.js before routes

const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const mongoSanitize = require('express-mongo-sanitize');
const xss = require('xss-clean');

// 1. Security Headers
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
            fontSrc: ["'self'", "https://fonts.gstatic.com"],
            scriptSrc: ["'self'"],
            imgSrc: ["'self'", "data:", "https:"],
            connectSrc: ["'self'", "https://api.mapbox.com"]
        }
    }
}));

// 2. Rate Limiting
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // 100 requests per IP
    message: 'Too many requests from this IP, please try again later',
    standardHeaders: true,
    legacyHeaders: false,
});

const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5, // 5 login attempts
    message: 'Too many login attempts, please try again later',
    skipSuccessfulRequests: true
});

const smsLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 10, // 10 SMS per hour per IP
    message: 'Too many SMS requests, please try again later'
});

// Apply rate limiters
app.use('/api/', apiLimiter);
app.use('/api/login', authLimiter);
app.use('/api/hospital/login', authLimiter);
app.use('/api/blood-requests', smsLimiter);

// 3. Data Sanitization
app.use(mongoSanitize()); // Prevent NoSQL injection
app.use(xss()); // Prevent XSS attacks

// 4. Disable x-powered-by header
app.disable('x-powered-by');

// 5. Force HTTPS in production
if (process.env.NODE_ENV === 'production') {
    app.use((req, res, next) => {
        if (req.header('x-forwarded-proto') !== 'https') {
            res.redirect(`https://${req.header('host')}${req.url}`);
        } else {
            next();
        }
    });
}

// 6. Improved error handling (add at the end of server.js)
app.use((err, req, res, next) => {
    console.error('Error:', err);

    // Don't expose stack traces in production
    const errorResponse = {
        success: false,
        message: process.env.NODE_ENV === 'production'
            ? 'An error occurred'
            : err.message
    };

    // Add stack trace only in development
    if (process.env.NODE_ENV !== 'production') {
        errorResponse.stack = err.stack;
    }

    res.status(err.status || 500).json(errorResponse);
});

// 7. Input validation helper
const { body, validationResult } = require('express-validator');

const validateLocation = [
    body('lat').isFloat({ min: -90, max: 90 }).withMessage('Invalid latitude'),
    body('lng').isFloat({ min: -180, max: 180 }).withMessage('Invalid longitude'),
    body('requestId').optional().isMongoId().withMessage('Invalid request ID'),
    (req, res, next) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({
                success: false,
                errors: errors.array()
            });
        }
        next();
    }
];

const validatePhoneNumber = [
    body('phone').matches(/^\+?[1-9]\d{1,14}$/).withMessage('Invalid phone number'),
    (req, res, next) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({
                success: false,
                errors: errors.array()
            });
        }
        next();
    }
];

// Export validators for use in routes
module.exports = {
    validateLocation,
    validatePhoneNumber
};
