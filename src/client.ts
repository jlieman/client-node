
import request, { AxiosRequestConfig }         from "axios";
import * as querystring                        from "querystring";
import * as _debug                             from "debug";
import * as jwt                                from "jsonwebtoken";
import { SMART }                               from "..";
import { getPath, getErrorText, getBundleURL } from "./lib";

const debug = _debug("smart");

/**
 * A SMART Client instance will simplify some tasks for you. It will authorize
 * requests automatically, use refresh tokens, handle errors and so on.
 */
export default class Client
{
    /**
     * The serialized state as it is stored in the session (or other storage).
     * Contains things like tokens, client secrets, settings and so on.
     */
    protected state: SMART.ClientState;

    constructor(state: SMART.ClientState)
    {
        // This might happen if the state have been lost (for example the server
        // was restarted and a memory storage was used).
        if (!state) {
            throw new Error("No state provided to the client");
        }
        this.state = state;
    }

    /**
     * Allows you to do the following:
     * 1. Use relative URLs (treat them as relative to the "serverUrl" option)
     * 2. Automatically authorize requests with your accessToken (if any)
     * 3. Automatically re-authorize using the refreshToken (if available)
     * 4. Automatically parse error operation outcomes and turn them into
     *   JavaScript Error objects with which the resulting promises are rejected
     * @param {object|string} options URL or axios request options
     */
    public async request(options: AxiosRequestConfig | string = {}): Promise<any>
    {
        if (typeof options == "string") {
            options = { url: options };
        }

        options.baseURL = this.state.serverUrl.replace(/\/?$/, "/");

        const accessToken = getPath(this.state, "tokenResponse.access_token");
        if (accessToken) {
            options.headers = {
                ...options.headers,
                Authorization: `Bearer ${accessToken}`
            };
        }

        return request(options).catch(error => {

            // The request was made and the server responded with a
            // status code that falls out of the range of 2xx
            if (error.response) {

                if (error.response.status == 401) {
                    debug("401 received");
                    if (getPath(this.state, "tokenResponse.refresh_token")) {
                        debug("Refreshing using the refresh token");
                        return this.refresh().then(() => this.request(options));
                    }
                }

                const resourceType = getPath(error, "response.data.resourceType");
                const issues = getPath(error, "response.data.issue");
                const body = error.response.data;
                if (resourceType == "OperationOutcome" && issues.length) {
                    debug("OperationOutcome error response detected");
                    const errors = body.issue.map((o: any) => `${o.severity} ${o.code} ${o.diagnostics}`);
                    throw new Error(errors.join("\n"));
                }

                throw error;
            }

            // The request was made but no response was received
            // "error.request" is an instance of http.ClientRequest
            throw new Error(getErrorText("no_fhir_response"));
        });
    }

    /**
     * Use the refresh token to obtain new access token.
     * If the refresh token is expired it will be deleted from the state, so
     * that we don't enter into loops trying to re-authorize.
     */
    public async refresh()
    {
        if (!this.state.tokenResponse || !this.state.tokenResponse.refresh_token) {
            throw new Error("Trying to refresh but there is no refresh token");
        }
        const refreshToken = getPath(this.state, "tokenResponse.refresh_token");

        return request({
            method: "POST",
            url: this.state.tokenUri,
            headers: {
                "content-type": "application/x-www-form-urlencoded"
            },
            data: querystring.stringify({
                grant_type: "refresh_token",
                refresh_token: refreshToken
            })
        }).then(({ data }) => {
            this.state.tokenResponse = { ...this.state.tokenResponse, ...data as SMART.TokenResponse };
            return data;
        })
        .catch(error => {
            if (error.response && error.response.status == 401) {
                debug("401 received - refresh token expired or invalid");
                debug("Deleting the expired or invalid refresh token");
                delete (this.state as SMART.ActiveClientState).tokenResponse.refresh_token;
            }
            throw error;
        });
    }

    /**
     * Returns the ID of the selected patient or null. You should have requested
     * "launch/patient" scope. Otherwise this will return null.
     */
    public getPatientId(): string | null
    {
        const tokenResponse = this.state.tokenResponse;
        if (tokenResponse) {
            // We have been authorized against this server but we don't know
            // the patient. This should be a scope issue.
            if (!tokenResponse.patient) {
                if (!this.state.scope.match(/\blaunch(\/patient)?\b/)) {
                    debug(
                        "You are trying to get the ID of the selected patient " +
                        "but you have not used the right scopes. Please add " +
                        "'launch/patient' to the scopes you request and try again."
                    );
                }
                else {
                    // The server should have returned the patient!
                    debug(
                        "The ID of the selected patient is not available. " +
                        "Please check if your server supports that."
                    );
                }
                return null;
            }
            return tokenResponse.patient;
        }

        if (this.state.authorizeUri) {
            debug(
                "You are trying to get the ID of the selected patient " +
                "but your app is not authorized yet."
            );
        }
        else {
            debug(
                "You are trying to get the ID of the selected patient " +
                "but your app needs to be authorized first. Please don't use " +
                "open fhir servers if you need to access launch context items " +
                "like the selected patient."
            );
        }
        return null;
    }

    /**
     * Returns the ID of the selected encounter or null. You should have
     * requested "launch/encounter" scope. Otherwise this will return null.
     * Note that not all servers support the "launch/encounter" scope so this
     * will be null if they don't.
     */
    public getEncounterId(): string | null
    {
        const tokenResponse = this.state.tokenResponse;
        if (tokenResponse) {
            // We have been authorized against this server but we don't know
            // the encounter. This should be a scope issue.
            if (!tokenResponse.encounter) {
                if (!this.state.scope.match(/\blaunch(\/encounter)?\b/)) {
                    debug(
                        "You are trying to get the ID of the selected encounter " +
                        "but you have not used the right scopes. Please add " +
                        "'launch/encounter' to the scopes you request and try again."
                    );
                }
                else {
                    // The server should have returned the patient!
                    debug(
                        "The ID of the selected encounter is not available. " +
                        "Please check if your server supports that, and that " +
                        "the selected patient has any recorded encounters."
                    );
                }
                return null;
            }
            return tokenResponse.encounter;
        }

        if (this.state.authorizeUri) {
            debug(
                "You are trying to get the ID of the selected encounter " +
                "but your app is not authorized yet."
            );
        }
        else {
            debug(
                "You are trying to get the ID of the selected encounter " +
                "but your app needs to be authorized first. Please don't use " +
                "open fhir servers if you need to access launch context items " +
                "like the selected encounter."
            );
        }
        return null;
    }

    /**
     * Returns the (decoded) id_token if any. You need to request "openid" and
     * "profile" scopes if you need to receive an id_token (if you need to know
     * who the logged-in user is).
     */
    public getIdToken(): SMART.IDToken | null
    {
        const tokenResponse = this.state.tokenResponse;
        if (tokenResponse) {
            const idToken = tokenResponse.id_token;

            // We have been authorized against this server but we don't have
            // the id_token. This should be a scope issue.
            if (!idToken) {
                if (!this.state.scope.match(/\bopenid\b/) || !this.state.scope.match(/\bconnect\b/)) {
                    debug(
                        "You are trying to get the id_token but you are not " +
                        "using the right scopes. Please add 'openid' and 'connect' " +
                        "to the scopes you request and try again."
                    );
                }
                else {
                    // The server should have returned the id_token!
                    debug(
                        "The id_token is not available. Please check if your " +
                        "server supports that."
                    );
                }
                return null;
            }
            return jwt.decode(idToken) as SMART.IDToken;
        }
        if (this.state.authorizeUri) {
            debug(
                "You are trying to get the id_token " +
                "but your app is not authorized yet."
            );
        }
        else {
            debug(
                "You are trying to get the id_token but your app needs to be " +
                "authorized first. Please don't use open fhir servers if you " +
                "need to access launch context items like the id_token."
            );
        }
        return null;
    }

    /**
     * Returns the profile of the logged_in user (if any). This is a string
     * having the following shape "{user type}/{user id}". For example:
     * "Practitioner/abc" or "Patient/xyz".
     */
    public getUserProfile(): string | null
    {
        const idToken = this.getIdToken();
        if (idToken) {
            return idToken.profile;
        }
        return null;
    }

    /**
     * Returns the user ID or null.
     */
    public getUserId(): string | null
    {
        const profile = this.getUserProfile();
        if (profile) {
            return profile.split("/")[1];
        }
        return null;
    }

    /**
     * Returns the type of the logged-in user or null. The result can be
     * "Practitioner", "Patient" or "RelatedPerson".
     */
    public getUserType(): string | null
    {
        const profile = this.getUserProfile();
        if (profile) {
            return profile.split("/")[0];
        }
        return null;
    }

    /**
     * Gets multiple bundle entries from multiple pages and returns an array
     * with all their entries. This can be used to walk a server and download
     * all the resources from certain type for example
     * @param options Request options
     * @param maxPages Max number of pages to fetch. Defaults to 100.
     */
    public getPages(
        options: AxiosRequestConfig | string,
        maxPages: number = 100,
        result: SMART.FhirBundleEntry[] = []
    ): Promise<SMART.FhirBundleEntry[]> {
        if (typeof options == "string") {
            options = { url: options };
        }
        return this.request(options).then(res => {
            const bundle = res.data as SMART.FhirBundle;
            result.push.apply(result, bundle.entry || []);
            if (--maxPages) {
                const nextUrl = getBundleURL(bundle, "next");
                if (nextUrl) {
                    return this.getPages({ ...options as AxiosRequestConfig, url: nextUrl }, maxPages, result);
                }
            }
            return result;
        });
    }

    public getTokenField(field: string): string | null
    {
        const tokenResponse = this.state.tokenResponse;
        if (tokenResponse) {
            // We have been authorized against this server but we don't know
            // the requested field. This could be a scope or configuration issue.
            if (!tokenResponse[field]) {
                // The server should have returned the field!
                debug(
                    `The field ${field} is not available in the token response. ` +
                    "Please check if your server supports that."
                );
                return null;
            }
            return tokenResponse[field];
        }

        if (this.state.authorizeUri) {
            debug(
                `You are trying to get the field ${field} ` +
                "but your app is not authorized yet."
            );
        }
        else {
            debug(
                `You are trying to get the field ${field} ` +
                "but your app needs to be authorized first."
            );
        }
        return null;
    }

    public getToken(): SMART.TokenResponse | undefined {
        return this.state.tokenResponse;
    }
}
