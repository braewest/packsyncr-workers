module.exports = async function (context, req) {
    // CORS for browser
    const CORS_HEADERS = {
        "Access-Control-Allow-Origin": "https://www.packsyncr.com",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Credentials": "true"
    };

    // CORS preflight
    if (req.method === "OPTIONS") {
        context.res = {
            status: 204,
            headers: {
                "Access-Control-Allow-Origin": "https://www.packsyncr.com",
                "Access-Control-Allow-Methods": "POST, OPTIONS",
                "Access-Control-Allow-Headers": "Content-Type",
                "Access-Control-Allow-Credentials": "true"
            }
        };
        return;
    }

    if (req.method !== "POST") {
        context.res = {
            status: 405,
            headers: CORS_HEADERS,
            body: JSON.stringify({ error: "method_not_allowed" })
        };
        return;
    }

    try {
        const { code } = req.body;
        if (!code) {
            context.res = {
                status: 400,
                headers: CORS_HEADERS,
                body: JSON.stringify({ error: "missing_authorization_code" })
            };
            return;
        }

        // Step 1: Get access tokens
        const { emailAccessToken, xblAccessToken } = await exchangeAuthCodeForTokens(code);

        // Step 2: Get Microsoft email
        const email = await getMsEmail(emailAccessToken);

        // Step 3: Xbox Live authentication
        const { xblToken, uhs } = await authTokenToXbl(xblAccessToken);

        // Step 4: Xbox Secure Token Service
        const xstsToken = await xblToXsts(xblToken);

        // Step 5: Minecraft Account Info
        const mcAccessToken = await xstsToMc(xstsToken, uhs);

        // Step 6: Verify Minecraft ownership
        const hasOwnership = await verifyMinecraftOwnership(mcAccessToken);

        // Step 7: Get Minecraft profile!!!
        const mcProfile = await getMcProfile(mcAccessToken);

        // Step 8: Call auth-gateway Cloudflare Worker
        const { refreshToken, isNewUser } = await getRefreshToken(email, mcProfile);

        // Step 9: Return refresh token and uuid as cookies
        context.res = {
            status: 200,
            headers: {
                ...CORS_HEADERS,
                "Content-Type": "application/json"
            },
            cookies: [
                {
                    name: "refresh_token",
                    value: refreshToken,
                    httpOnly: true,
                    secure: true,
                    sameSite: "None",
                    domain: ".packsyncr.com",
                    path: "/access-token",
                    maxAge: parseInt(process.env.REFRESH_TOKEN_EXPIRY_SECONDS, 10) || 15552000
                },
                {
                    name: "uuid",
                    value: mcProfile.id,
                    httpOnly: true,
                    secure: true,
                    sameSite: "None",
                    domain: ".packsyncr.com",
                    path: "/access-token",
                    maxAge: parseInt(process.env.REFRESH_TOKEN_EXPIRY_SECONDS, 10) || 15552000
                }
            ],
            body: {
                success: true,
                newUser: isNewUser
            }
        };
        return;
    } catch (err) {
        context.res = {
            status: 500,
            headers: CORS_HEADERS,
            body: JSON.stringify({ error: String(err) })
        };
        return;
    }
}

// Step 1: Exchange Microsoft auth code -> email + xbl access tokens
async function exchangeAuthCodeForTokens(code) {
    // Exchange auth code for refresh token and Microsoft Graph access token (email)
    const emailTokenResponse = await fetch("https://login.microsoftonline.com/consumers/oauth2/v2.0/token", {
        method: "POST",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded"
        },
        body: new URLSearchParams({
            client_id: process.env.CLIENT_ID,
            client_secret: process.env.CLIENT_SECRET,
            code: code,
            redirect_uri: process.env.REDIRECT_URI,
            grant_type: "authorization_code",
            scope: "User.Read offline_access"
        })
    });

    const emailTokenData = await emailTokenResponse.json();
    if (!emailTokenResponse.ok) {
        throw new Error("email_token_retrieval_failed");
    }
    const refreshToken = emailTokenData.refresh_token;
    
    // Use refresh token to get Xbox Live access token
    const xblTokenResponse = await fetch("https://login.microsoftonline.com/consumers/oauth2/v2.0/token", {
        method: "POST",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded"
        },
        body: new URLSearchParams({
            client_id: process.env.CLIENT_ID,
            client_secret: process.env.CLIENT_SECRET,
            grant_type: "refresh_token",
            refresh_token: refreshToken,
            scope: "XboxLive.signin offline_access"
        })
    });

    const xblTokenData = await xblTokenResponse.json();
    if (!xblTokenResponse.ok) {
        throw new Error("xbl_token_retrieval_failed");
    }

    return {
        emailAccessToken: emailTokenData.access_token,
        xblAccessToken: xblTokenData.access_token
    };
}

// Step 2: auth token -> msEmail
async function getMsEmail(authToken) {
    const response = await fetch("https://graph.microsoft.com/v1.0/me", {
        headers: {
            "Authorization": `Bearer ${authToken}`,
            "Accept": "application/json"
        }
    });

    const data = await response.json();

    if (!response.ok) {
        throw new Error("email_retrieval_failed");
    }
    return data.mail || data.userPrincipalName;
}

// Step 3: auth token -> XBL (Xbox Live)
async function authTokenToXbl(authToken) {
    const body = {
        Properties: {
            AuthMethod: "RPS",
            SiteName: "user.auth.xboxlive.com",
            RpsTicket: `d=${authToken}`
        },
        RelyingParty: "http://auth.xboxlive.com",
        TokenType: "JWT"
    };

    const response = await fetch("https://user.auth.xboxlive.com/user/authenticate", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Accept": "application/json"
        },
        body: JSON.stringify(body)
    });

    const data = await response.json();

    if (!response.ok) {
        throw new Error("xbl_retrieval_failed");
    }
    return {
        xblToken: data.Token,
        uhs: data.DisplayClaims.xui[0].uhs
    };
}

// Step 4: XBL -> XSTS
async function xblToXsts(xblToken) {
    const body = {
        Properties: {
            SandboxId: "RETAIL",
            UserTokens: [xblToken]
        },
        RelyingParty: "rp://api.minecraftservices.com/",
        TokenType: "JWT"
    };

    const response = await fetch("https://xsts.auth.xboxlive.com/xsts/authorize", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Accept": "application/json"
        },
        body: JSON.stringify(body)
    });

    const data = await response.json();

    if (!response.ok) {
        throw new Error("xsts_retrieval_failed");
    }
    return data.Token;
}

// Step 5: XSTS -> Minecraft access token
async function xstsToMc(xstsToken, uhs) {
    const body = {
        identityToken: `XBL3.0 x=${uhs};${xstsToken}`
    };

    const response = await fetch("https://api.minecraftservices.com/authentication/login_with_xbox", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Accept": "application/json"
        },
        body: JSON.stringify(body)
    });

    const rawText = await response.text();
    let data;
    try {
        data = JSON.parse(rawText);
    } catch {
        throw new Error("minecraft_token_retrieval_failed");
    }

    if (!response.ok) {
        throw new Error("minecraft_token_retrieval_failed");
    }
    return data.access_token;
}

// Step 6: Verify Minecraft ownership
async function verifyMinecraftOwnership(mcAccessToken) {
    const response = await fetch("https://api.minecraftservices.com/entitlements/mcstore", {
        method: "GET",
        headers: {
            "Authorization": `Bearer ${mcAccessToken}`,
            "Accept": "application/json"
        }
    });

    const data = await response.json();

    if (!data.items || data.items.length === 0) {
        throw new Error("Minecraft ownership not detected");
    }
    return true;
}

// Step 7: McAccessToken -> McProfile
async function getMcProfile(mcAccessToken) {
    const response = await fetch("https://api.minecraftservices.com/minecraft/profile", {
        method: "GET",
        headers: {
            "Authorization": `Bearer ${mcAccessToken}`,
            "Accept": "application/json"
        }
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error("minecraft_profile_retrieval_failed");
    }
    const data = await response.json();
    return data;
}

// Step 8: Retrieve refresh token from Cloudflare
async function getRefreshToken(email, mcProfile) {
    const response = await fetch("https://auth.packsyncr.com/refresh-token", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "x-internal-auth": process.env.INTERNAL_SECRET
        },
        body: JSON.stringify({
            uuid: mcProfile.id,
            username: mcProfile.name,
            email: email
        })
    });

    const data = await response.json();
    if (!response.ok) {
        throw new Error("refresh_token_generation_failed");
    }
    return {
        refreshToken: data.refresh_token,
        isNewUser: data.newUser
    };
}
