/**
 * Authenticates in the browser if credentials are provided.
 */
const authenticate = async (page, username, password) => {
    if (username && password) {
        await page.authenticate({ username, password });
    }
};

export default authenticate;
