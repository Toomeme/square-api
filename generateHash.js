// generateHash.js
const bcrypt = require('bcrypt');
const saltRounds = 10; // Use the same rounds as your pre-save hook
const myPlainPassword = "fatbeagle"; // Replace with the actual password

async function createHash() {
    try {
        const hash = await bcrypt.hash(myPlainPassword, saltRounds);
        console.log("Plain Password:", myPlainPassword);
        console.log("Generated Hash:", hash); // Copy this new hash
        console.log("Hash Length:", hash.length); // Should be 60
    } catch (err) {
        console.error("Error generating hash:", err);
    }
}
createHash();