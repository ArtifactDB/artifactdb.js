import * as err from "./HttpError.js";
import * as gh from "./globalRequestHeaders.js";

/**
 * Start an upload of a new version of a project.
 *
 * @param {string} startUrl - Full URL to the endpoint to create a new project, see {@linkcode createUploadStartUrl}.
 * @param {Object} checksums - Object describing the to-be-uploaded files in the new project.
 * Keys are the relative paths of the files inside the project, and values are their MD5 checksums.
 * Note that checksums are ignored for `apiVersion=1`.
 * @param {Object} [options={}] - Optional parameters.
 * @param {boolean} [options.autoDedupMd5=true] - Whether to perform automatic deduplication of files in `checksums` based on matching MD5 checksums to files of the same name in a previous version of the project.
 * @param {string} [options.md5Field="md5sum"] - Field in the metadata containing the MD5 checksum for the file.
 * Only used for MD5-based deduplication.
 * @param {Object} [options.dedupMd5Paths={}] - Object specifying the files to use in MD5-based deduplication.
 * Like `checksums`, keys are the relative paths and values are their MD5 checksums; however, the keys should not have any overlap with those in `checksums`.
 * `dedupMd5Paths` is a more explicit approach to listing files that are to be deduplicated, e.g., if only a subset of files are to be deduplicated.
 * @param {Object} [options.dedupLinkPaths={}] - Object specifying files to use in link-based deduplication.
 * Keys are the relative paths and values are the ArtifactDB identifiers to be linked to.
 * Keys in this object should not have any overlap with those in `checksums` or `dedupMd5Paths`.
 * @param {?function} [options.postFun=null] - Function that performs a POST request and returns a Response object.
 * It should accept:
 *
 * - A string containing the request URL.
 * - An object containing the permissions to be sent in the request.
 * 
 * Defaults to the in-built `fetch` function with {@linkcode globalRequestHeaders}.
 * @param {?number} [options.expires=null] - Number of days until the uploaded version expires.
 * If `null`, no expiry date is set, i.e., the upload is permanent.
 * @param {number} [options.apiVersion=2] - Version of the API used for upload.
 *
 * @return {Object} Object containing the following:
 *
 * - `presigned_urls`: array of objects containing presigned URLs and base64-encoded MD5 checksums for each file to be uploaded.
 * - `links`: array of objects containing URLs for each file to be linked to an existing ArtifactDB identifier.
 * - `completion_url`: string containing the URL component to use to indicate that the upload is complete.
 * - `abort_url`: string containing the URL component to use to indicate that the upload is aborted.
 *
 * These are primarily used by passing the entire object to {@linkcode uploadFiles}, {@linkcode completeUpload} or {@linkcode abortUpload}.
 * @async
 */
export async function initializeUpload(startUrl, checksums, { autoDedupMd5 = true, md5Field = "md5sum", dedupMd5Paths = {}, dedupLinkPaths = {}, postFun = null, expires = null, apiVersion = 2 } = {}) {
    let filenames = [];
    let sofar = new Set;

    for (const [k, v] of Object.entries(checksums)) {
        let payload;
        if (apiVersion == 1) {
            payload = k;
        } else {
            payload = { filename: k, value: { md5sum: v } };
            if (autoDedupMd5 && !k.endsWith(".json")) {
                payload.check = "md5";
                payload.value.field = md5Field;
            } else {
                payload.check = "simple";
            }
        }

        filenames.push(payload);
        sofar.add(k);
    }

    for (const [k, v] of Object.entries(dedupMd5Paths)) {
        if (sofar.has(k)) {
            throw new Error("multiple occurrences of path '" + k + "'");
        }
        if (k.endsWith(".json")) {
            throw new Error("cannot deduplicate JSON file '" + k + "'");
        }
        filenames.push({ filename: k, check: "md5", value: { md5sum: v, field: md5Field } });
        sofar.add(k);
    }

    for (const [k, v] of Object.entries(dedupLinkPaths)) {
        if (sofar.has(k)) {
            throw new Error("multiple occurrences of path '" + k + "'");
        }
        if (k.endsWith(".json")) {
            throw new Error("cannot deduplicate JSON file '" + k + "'");
        }
        filenames.push({ filename: k, check: "link", value: { artifactdb_id: v } });
    }

    let req = { 
        filenames: filenames,
        mode: "s3-presigned-url"
    };
    if (expires !== null) {
        req.expires_in = "in " + String(expires) + " days";
        req.completed_by = req.expires_in;
    }

    if (postFun === null) {
        postFun = (url, body) => {
            return fetch(url, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    ...gh.globalRequestHeaders
                },
                body: JSON.stringify(body)
            });
        };
    }

    let res = await postFun(startUrl, req);
    await err.checkHttpResponse(res, "failed to start a project upload");
    return await res.json();
}

/**
 * Create the upload start URL to use in {@linkcode initializeUpload}.
 *
 * @param {string} baseUrl - Base URL of the ArtifactDB REST API.
 * @param {string} project - Name of the project.
 * @param {string} version - Version to be uploaded.
 *
 * @return {string} Full URL for the upload start endpoint.
 */
export function createUploadStartUrl(baseUrl, project, version) {
    return baseUrl + "/projects/" + encodeURIComponent(project) + "/version/" + encodeURIComponent(version) + "/upload";
}

/**
 * Upload file contents and create backend links.
 *
 * @param {string} baseUrl - Base URL of the ArtifactDB REST API.
 * @param {Object} initial - Object returned by {@linkcode initializeUpload}.
 * @param {Object} contents - Object where each entry corresponds to a file to be uploaded.
 * Each key should be a relative path, and the object should contain a superset of the keys used in `checksums` and `dedupMd5Paths` of {@linkcode initializeUpload}.
 * Each value represents the contents of the file and can be anything that is understood by `presignedPutFun`.
 * For the default function, this is anything that can be uploaded by `fetch`, most typically a string or ArrayBuffer.
 * @param {Object} [options={}] - Optional parameters.
 * @param {?function} [options.putFun=null] - Function that performs a PUT request without any body, given the URL as a single argument, and returns a Response object.
 * If `null`, it defaults to `fetch` with the {@linkcode globalRequestHeaders}.
 * @param {?function} [options.presignedPutFun=null] - Function that performs a PUT request to a presigned URL and returns a Response object.
 * This should take the following arguments:
 *
 * - `path`: String containing the relative path of the file. 
 *   This can be inspected to determine an appropriate `Content-Type` header.
 * - `url`: String containing the presigned URL.
 * - `md5`: String containing the base64-encoded MD5 checksum for this file.
 * - `value`: The file contents from `contents`.
 *
 * If `null`, it defaults to `fetch` with the {@linkcode globalRequestHeaders}.
 *
 * @return Files are uploaded and nothing is returned.
 * @async
 */
export async function uploadFiles(baseUrl, initial, contents, { putFun = null, presignedPutFun = null }={}) {
    if (putFun === null) {
        putFun = gh.quickPutJson;
    }

    {
        let promises = [];
        if (initial.links instanceof Array) { // new API returns an array with path components.
            for (const x of initial.links) {
                promises.push(putFun(baseUrl + x.url));
            }

            let responses = await Promise.all(promises);
            for (var i = 0; i < responses.length; i++) {
                await err.checkHttpResponse(responses[i], "failed to create links for path '" + initial.links[i].filename + "'");
            }

        } else {
            for (const x of Object.values(initial.links)) { // old API returns a dictionary of full paths.
                promises.push(putFun(x));
            }

            let responses = await Promise.all(promises);
            for (var i = 0; i < responses.length; i++) {
                await err.checkHttpResponse(responses[i], "failed to create links for path '" + initial.links[i] + "'");
            }
        }
    }

    if (presignedPutFun == null) {
        presignedPutFun = (path, url, md5sum, value) => {
            let headers = {
                // Don't use global headers here! Presigned URLs don't like auth.
                "Content-Type": (path.endsWith(".json") ? "application/json" : "application/octet-stream")
            };
            if (md5sum !== null) {
                headers["Content-Md5"] = md5sum;
            }
            return fetch(url, {
                method: "PUT",
                headers: headers,
                body: value
            });
        };
    }

    {
        let promises = [];
        if (initial.presigned_urls instanceof Array) { // new API returns an array.
            for (const x of initial.presigned_urls) {
                if (!(x.filename in contents)) {
                    throw new Error("failed to find path '" + x.filename + "' in contents");
                }
                promises.push(presignedPutFun(x.filename, x.url, x.md5sum, contents[x.filename]));
            }
        } else {
            for (const [name, url] of Object.entries(initial.presigned_urls)) { // old API just returns the path directly, with no MD5sum.
                if (!(name in contents)) {
                    throw new Error("failed to find path '" + name + "' in contents");
                }
                promises.push(presignedPutFun(name, url, null, contents[name]));
            }
        }

        await Promise.all(promises);
        let responses = await Promise.all(promises);
        for (var i = 0; i < responses.length; i++) {
            let res = responses[i];
            if (res.ok) {
                continue;
            }

            let txt = await res.text();
            throw new Error("failed to upload to presigned URL for path '" + initial.presigned_urls[i].filename + "': " + txt);
        }
    }

    return;
}

/**
 * Complete the project upload.
 *
 * @param {string} baseUrl - Base URL of the ArtifactDB REST API.
 * @param {Object} initial - Object returned by {@linkcode initializeUpload}.
 * @param {Object} [options={}] - Optional parameters.
 * @param {number} [options.indexWait=600] - Number of seconds to wait for indexing to complete/fail before returning.
 * @param {boolean} [options.isPublic=true] - Whether to make the project publicly visible.
 * This only has an effect for new projects without any prior versions.
 * @param {?Array} [options.viewers=null] - Array of strings containing the user names of the viewers.
 * This only has an effect for new projects without any prior versions.
 * Defaults to an empty list.
 * @param {Array} [options.owners=null] - Array of strings containing the user names of the owners.
 * This only has an effect for new projects without any prior versions.
 * Default depends on the instance policy, usually set to the uploading user.
 * @param {?function} [options.getFun=null] - Function that accepts a single string containing a URL and returns a Response object.
 * Defaults to the in-built `fetch` function with {@linkcode globalRequestHeaders}.
 * @param {?function} [options.putFun=null] - Function that performs a PUT request and returns a Response object.
 * It should accept:
 *
 * - A string containing the request URL.
 * - An object containing the permissions to be sent in the request.
 *
 * If `null`, it defaults to `fetch` with the {@linkcode globalRequestHeaders}.
 *
 * @return {Object} Object containing:
 *
 * - `indexed`: boolean indicating whether the indexing was completed.
 *   If `false`, the indexing is still in progress.
 * - `job_id`: the job ID.
 *
 * @async
 */
export async function completeUpload(baseUrl, initial, { indexWait = 600, isPublic = true, viewers = null, owners = null, getFun = null, putFun = null } = {}) {
    if (putFun === null) {
        putFun = gh.quickPutJson;
    }

    let permissions = { read_access: (isPublic ? "public" : "viewers") };
    if (owners !== null) {
        permissions.owners = owners;
    }
    if (viewers !== null) {
        permissions.viewers = viewers;
    }

    let url;
    if (initial.completion_url.startsWith("http")) { 
        url = initial.completion_url; // old API returns the entire URL.
    } else {
        url = baseUrl + initial.completion_url;
    }
    let res = await putFun(url, permissions);
    await err.checkHttpResponse(res, "failed to complete the project upload");

    let job_info = await res.json();
    let job_str = String(job_info.job_id);
    if (getFun == null) {
        getFun = gh.quickGet;
    }

    let start = Date.now();
    let okay = false;
    while (Date.now() - start < indexWait * 1000) {
        await (new Promise(resolve => setTimeout(resolve(null), 5000))); // wait for 5 seconds.

        let status_url = baseUrl + "/jobs/" + job_str;
        let res = await getFun(status_url);
        err.checkHttpResponse(res, "failed to query status for job " + job_str);
        let state = await res.json();

        if (state.status == "SUCCESS") {
            okay = true;
            break;
        } else if (state.status == "FAILURE") {
            throw new Error("indexing failure on job " + job_str + ", see " + status_url + " for more details");
        }
    }

    return { "indexed": okay, "job_id": job_info.job_id };
}

/**
 * Complete the project upload.
 *
 * @param {string} baseUrl - Base URL of the ArtifactDB REST API.
 * @param {Object} initial - Object returned by {@linkcode initializeUpload}.
 * @param {Object} [options={}] - Optional parameters.
 * @param {?function} [options.putFun=null] - Function that performs a PUT request without any body and returns a Response object.
 * If `null`, it defaults to `fetch` with the {@linkcode globalRequestHeaders}.
 *
 * @return The project upload is aborted; nothing is returned.
 * @async
 */
export async function abortUpload(baseUrl, initial, { putFun = null } = {}) {
    if (putFun == null) {
        putFun = gh.quickPutJson;
    }
    let res = await putFun(baseUrl + initial.abort_url);
    await err.checkHttpResponse(res, "failed to abort the project upload");
    return;
}
