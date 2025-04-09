// utils/mailer.js
const nodemailer = require('nodemailer');

// --- Configure Transport based on .env ---
let transporter;
 if (process.env.EMAIL_HOST && process.env.EMAIL_USER && process.env.EMAIL_PASS) {
    // Option A: Standard SMTP
    console.log(`Configuring Nodemailer for SMTP: ${process.env.EMAIL_HOST}`);
    transporter = nodemailer.createTransport({
        host: process.env.EMAIL_HOST,
        port: parseInt(process.env.EMAIL_PORT || '587', 10),
        secure: process.env.EMAIL_SECURE === 'true', // true for 465, false for 587
        auth: {
            user: process.env.EMAIL_USER,
            pass: process.env.EMAIL_PASS,
        },
        // Optional: Add TLS options if needed for specific providers
        // tls: {
        //     ciphers:'SSLv3'
        // }
    });
} else {
    console.warn("Email transport not configured. Email notifications will be disabled.");
    // Optional: Create a dummy transporter that just logs
    transporter = {
        sendMail: (mailOptions) => {
             console.log("--- EMAIL SIMULATION (Transport not configured) ---");
             console.log("To:", mailOptions.to);
             console.log("Subject:", mailOptions.subject);
             console.log("Body (HTML):", mailOptions.html || mailOptions.text);
             console.log("--- END EMAIL SIMULATION ---");
             return Promise.resolve({ messageId: 'simulated_' + Date.now() });
         }
    };
}


// --- Email Sending Function ---
const sendAdminBookingNotification = async (bookingDetails) => {
    if (!transporter || !process.env.ADMIN_EMAIL_RECIPIENT) {
        console.warn("Cannot send admin notification: Email transport or recipient not configured.");
        return;
    }

    // Ensure bookingDetails has user info populated if needed
    const user = bookingDetails.user || {}; // Handle if user is not populated
    const details = bookingDetails.details || {};
    const serviceType = bookingDetails.serviceType || 'Unknown Service';
    const startDate = bookingDetails.start ? new Date(bookingDetails.start) : null;
    const endDate = bookingDetails.end ? new Date(bookingDetails.end) : null;

    const subject = `New Booking Confirmation: ${serviceType.charAt(0).toUpperCase() + serviceType.slice(1)} - ${user.username || 'Unknown User'}`;

    let htmlBody = `
        <h1>New Booking Received!</h1>
        <p>A new booking has been successfully created:</p>
        <ul>
            <li><strong>Booking ID:</strong> ${bookingDetails._id}</li>
            <li><strong>User ID:</strong> ${user._id || 'N/A'}</li>
            <li><strong>Username:</strong> ${user.username || 'N/A'}</li>
            <li><strong>Email:</strong> ${user.email || 'N/A'}</li>
            <li><strong>Service Type:</strong> ${serviceType}</li>
    `;

    // Add details specific to booking type
    if (startDate && endDate && serviceType !== 'openplay' || details.option === 'dropin') {
         htmlBody += `<li><strong>Date:</strong> ${startDate.toLocaleDateString('en-US', { timeZone: businessTimeZone, weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' })}</li>`;
         htmlBody += `<li><strong>Time:</strong> ${startDate.toLocaleTimeString('en-US', { timeZone: businessTimeZone, hour: 'numeric', minute: '2-digit' })} - ${endDate.toLocaleTimeString('en-US', { timeZone: businessTimeZone, hour: 'numeric', minute: '2-digit' })}</li>`;
    }

    if (serviceType === 'openplay') {
        htmlBody += `<li><strong>Option:</strong> ${details.option || 'N/A'}</li>`;
        if(details.option !== 'dropin') {
             htmlBody += `<li><strong>Purchase Time:</strong> ${new Date(bookingDetails.createdAt || Date.now()).toLocaleString('en-US', { timeZone: businessTimeZone })}</li>`;
        }
    } else if (serviceType === 'playgroup') {
         htmlBody += `<li><strong>Semester:</strong> ${details.semesterStart} to ${details.semesterEnd}</li>`;
         htmlBody += `<li><strong>Payment Ref:</strong> ${details.subscriptionId ? `Sub: ${details.subscriptionId}` : `PI: ${details.paymentIntentId}`}</li>`;
    } else if (serviceType === 'birthday') {
         htmlBody += `<li><strong>Duration:</strong> ${details.partyDuration || details.duration || 'N/A'} hours</li>`; // Use appropriate detail field
    }

    htmlBody += `<li><strong>Cost Recorded:</strong> $${(bookingDetails.cost || 0).toFixed(2)}</li>`; // Cost stored on this specific booking record
    htmlBody += `<li><strong>Booking Status:</strong> ${bookingDetails.status}</li>`;
    htmlBody += `<li><strong>Timestamp:</strong> ${new Date(bookingDetails.createdAt || Date.now()).toLocaleString('en-US', { timeZone: businessTimeZone })}</li>`;

    htmlBody += `</ul>
        <p>Booking Details Object:</p>
        <pre>${JSON.stringify(bookingDetails.details, null, 2)}</pre>
    `;

    const mailOptions = {
        from: process.env.EMAIL_FROM || process.env.EMAIL_USER, // Use verified sender for SendGrid/SES
        to: process.env.ADMIN_EMAIL_RECIPIENT,
        subject: subject,
        html: htmlBody,
        text: `New booking received for ${user.username || 'Unknown User'} - ${serviceType}. Booking ID: ${bookingDetails._id}`, // Fallback text
    };

    try {
        console.log(`Sending admin notification email to ${process.env.ADMIN_EMAIL_RECIPIENT} for booking ${bookingDetails._id}...`);
        let info = await transporter.sendMail(mailOptions);
        console.log('Admin notification email sent successfully: %s', info.messageId);
    } catch (error) {
        console.error('Error sending admin notification email:', error);
        // Don't let email failure stop the main process
    }
};

module.exports = { sendAdminBookingNotification };