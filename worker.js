//
// Proxy GameVault game download API requests, redirecting to Backblaze B2, and sending notifications to a webhook
//
// Adapted from https://github.com/backblaze-b2-samples/cloudflare-b2
//

import { AwsClient } from 'aws4fetch.esm.js' // Uploaded alongside worker.js from https://github.com/mhart/aws4fetch

const UNSIGNABLE_HEADERS = [
    // These headers appear in the request, but are not passed upstream
    'x-forwarded-proto',
    'x-real-ip',
    // We can't include accept-encoding in the signature because Cloudflare
    // sets the incoming accept-encoding header to "gzip, br", then modifies
    // the outgoing request to set accept-encoding to "gzip".
    // Not cool, Cloudflare!
    'accept-encoding',
];

// URL needs colon suffix on protocol, and port as a string
const HTTPS_PROTOCOL = "https:";
const HTTPS_PORT = "443";

// How many times to retry a range request where the response is missing content-range
const RETRY_ON_RANGE_ATTEMPTS = 3;

// How many times to retry a range request where the response was a 500/503 error
const RETRY_ON_500_ATTEMPTS = 3;

// Filter out cf-* and any other headers we don't want to include in the signature
function filterHeaders(headers, env) {
    return new Headers(Array.from(headers.entries())
        .filter(pair =>
            !UNSIGNABLE_HEADERS.includes(pair[0])
            && !pair[0].startsWith('cf-')
            && !('ALLOWED_HEADERS' in env && !env.ALLOWED_HEADERS.includes(pair[0]))
        ));
}

let discordWebhookUrl;

async function notifyDiscord(message) {
    try {
        if (discordWebhookUrl)
            await fetch(discordWebhookUrl, {
                method: 'POST',
                body: JSON.stringify({ content: message }),
                headers: new Headers({ "Content-Type": "application/json" }),
            });
    }
    catch (error) {
        console.error('Error sending notification to Discord:', error);
    }
}

let logLevel;
const logLevels = {
    ERROR: 0,
    WARN: 1,
    INFO: 2,
    DEBUG: 3,
    TRACE: 4,
    ALL: 5
};

async function log(message, severity) {
    // Handle console logging based on severity
    switch (severity) {
        case logLevels.ERROR:
            console.error(message);
            break;
        case logLevels.WARN:
            console.warn(message);
            break;
        case logLevels.INFO:
            console.info(message);
            break;
        case logLevels.DEBUG:
            console.debug(message);
            break;
        default:
            console.log(message); // Fallback to console.log
            break;
    }

    if (logLevel >= severity) {
        notifyDiscord(message);
    }
}

function parseLogLevel(levelString) {
    // Convert the string to uppercase to match the keys in logLevels
    const level = levelString.toUpperCase();
    return logLevels[level] !== undefined ? logLevels[level] : 2; // Default to INFO
}

export default {
    async fetch(request, env) {
        discordWebhookUrl = env.DISCORD_WEBHOOK; // Store the webhook URL globally
        logLevel = parseLogLevel(env.LOG_LEVEL); // Store the log level globally

        const url = new URL(request.url);

        if (!url.pathname.endsWith("/download"))
            return fetch(request);

        // Only allow GET and HEAD methods
        if (!['GET', 'HEAD'].includes(request.method)) {
            return new Response(null, {
                status: 405,
                statusText: "Method Not Allowed"
            });
        }

        // Authorize the user against the GV API. We don't check against /download
        // because we need to get the filename from the API call one level higher.
        var auth_url = new URL(request.url.slice(0, -9));

        var auth_response = await fetch(auth_url, { headers: request.headers });

        // We are checking the response of the /game/[id] API. If it's anything
        // other than 200, let GameVault handle the communication.
        if (!auth_response.ok)
            return fetch(request);

        // Grab the file name from the auth check response.
        var auth_json = await auth_response.json();
        var filepath = auth_json.file_path.toString().slice(1);

        // GV stores all game files in /files
        if (filepath.startsWith(env.GV_INTERNAL_FOLDER))
            filepath = filepath.slice(env.GV_INTERNAL_FOLDER.length + 1);
        // Rclone can have the bucket name as the folder at it's root.
        if (filepath.startsWith(env.BUCKET_NAME))
            filepath = filepath.slice(env.BUCKET_NAME.length + 1);

        // Gather the username from the auth header
        var user = atob(request.headers.get("Authorization").split(" ")[1]).split(":")[0];

        // Incoming protocol and port is taken from the worker's environment.
        // Local dev mode uses plain http on 8787, and it's possible to deploy
        // a worker on plain http. B2 only supports https on 443
        url.protocol = HTTPS_PROTOCOL;
        url.port = HTTPS_PORT;

        // Remove trailing and leading slashes from path
        let path = url.pathname;
        if (path.startsWith('/'))
            path = path.slice(1);
        if (path.endsWith('/'))
            path = path.slice(0, -1);

        // Bucket name must be specified in the BUCKET_NAME variable
        url.hostname = env.BUCKET_NAME + "." + env.B2_ENDPOINT;
        url.pathname = env.GV_FOLDER + filepath;

        // Certain headers, such as x-real-ip, appear in the incoming request but
        // are removed from the outgoing request. If they are in the outgoing
        // signed headers, B2 can't validate the signature.
        const headers = filterHeaders(request.headers, env);

        // Extract the region from the endpoint 
        const endpointRegex = /^s3\.([a-zA-Z0-9-]+)\.backblazeb2\.com$/;
        const [, aws_region] = env.B2_ENDPOINT.match(endpointRegex);

        // Create an S3 API client that can sign the outgoing request
        // @ts-ignore
        const client = new AwsClient({
            "accessKeyId": env.B2_APPLICATION_KEY_ID,
            "secretAccessKey": env.B2_APPLICATION_KEY,
            "service": "s3",
            "region": aws_region,
        });

        // Sign the outgoing request
        const signedRequest = await client.sign(url.toString(), {
            method: request.method,
            headers: headers
        });

        // For large files, Cloudflare will return the entire file, rather than the requested range
        // So, if there is a range header in the request, check that the response contains the
        // content-range header. If not, abort the request and try again.
        // See https://community.cloudflare.com/t/cloudflare-worker-fetch-ignores-byte-request-range-on-initial-request/395047/4
        if (signedRequest.headers.has("range")) {
            let range_attempts = RETRY_ON_RANGE_ATTEMPTS;
            let attempts = RETRY_ON_500_ATTEMPTS;

            let response;
            do {
                let controller = new AbortController();
                response = await fetch(signedRequest.url, {
                    method: signedRequest.method,
                    headers: signedRequest.headers,
                    signal: controller.signal,
                });
                if (response.headers.has("content-range")) {
                    // Only log if it didn't work first time
                    if (range_attempts < RETRY_ON_RANGE_ATTEMPTS) {
                        log(`Retry for ${signedRequest.url} succeeded - response has content-range header`, logLevels.DEBUG);
                    }

                    // If the discord webhook is configured, push the username and file details.
                    log(`${user} has started downloading ${auth_json.title} [${filepath}]`, logLevels.INFO)

                    // Break out of loop and return the response
                    break;
                } else if (response.ok) {
                    range_attempts -= 1;
                    log(`Range header in request for ${signedRequest.url} but no content-range header in response. Will retry ${range_attempts} more times`, logLevels.ERROR);
                    // Do not abort on the last attempt, as we want to return the response
                    if (range_attempts > 0) {
                        controller.abort();
                    }
                } else if ([500, 503].includes(response.status)) {
                    attempts -= 1;
                    log(`${response.status} error encountered on ${signedRequest.url}. Will retry ${attempts} more times`, logLevels.ERROR);
                    // After the second 500 error, wait half a second
                    if (RETRY_ON_500_ATTEMPTS - 2 == attempts) {
                        await new Promise(r => setTimeout(() => r(), 500));
                    }
                    // Do not abort on the last attempt, as we want to return the response
                    if (range_attempts > 0) {
                        controller.abort();
                    }
                } else {
                    // Response is not ok, so don't retry
                    break;
                }
            } while (range_attempts > 0 && attempts > 0);

            if (range_attempts <= 0) {
                log(`Tried range request for ${signedRequest.url} ${RETRY_ON_RANGE_ATTEMPTS} times, but no content-range in response.`, logLevels.ERROR);
            }

            // Return whatever response we have rather than an error response
            // This response cannot be aborted, otherwise it will raise an exception
            return response;
        }

        let response;
        let attempts = RETRY_ON_500_ATTEMPTS;
        do {
            let controller = new AbortController();
            response = await fetch(signedRequest);

            if (response.ok) {
                // If the discord webhook is configured, push the username and file details.
                log(`${user} has started downloading ${auth_json.title} [${filepath}]`, logLevels.INFO)

                // Send the signed request to B2, returning the upstream response
                return response;
            } else if ([500, 503].includes(response.status)) {
                attempts -= 1;
                log(`${response.status} error encountered on ${signedRequest.url}. Will retry ${attempts} more times`, logLevels.ERROR);
                // After the second 500 error, wait half a second
                if (RETRY_ON_500_ATTEMPTS - 2 == attempts) {
                    await new Promise(r => setTimeout(r, 500));
                }
                // Do not abort on the last attempt, as we want to return the response
                if (attempts > 0) {
                    controller.abort();
                }
            } else {
                // Response is not ok, so don't retry
                break;
            }

            return response;
        }
        while (attempts < 0);
    },
};
