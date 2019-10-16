const mocha = require('mocha');
const describe = mocha.describe;
const it = mocha.it;
const run = mocha.run;

const chai = require("chai");
const expect = chai.expect;

const path = require('path');
const Promise = require('bluebird');
const addContext = require('mochawesome/addContext');
const rp = require('request-promise');

const promiseFor = Promise.method(function (condition, action, value) {
    if (!condition(value))
        return value;
    return action(value).then(promiseFor.bind(null, condition, action));
});


const port = (process.env.CICD_WEB_HTTPS_PORT) ? process.env.CICD_WEB_HTTPS_PORT : process.env.CICD_WEB_HTTP_PORT || 8080;
const cicdServerFqdn = (process.env.CICD_GULP_HOST_FQDN) ? process.env.CICD_GULP_HOST_FQDN : `${(process.env.CICD_WEB_HTTPS_PORT) ? 'https' : 'http'}://${process.env.CICD_WEB_HOST_NAME || 'localhost'}:${port}`;

const ROUTE_TEST_EXECUTE = '/build/test';

const Git = require('sn-project/lib/git');

const rpd = rp.defaults({
    json: true,
    baseUrl: cicdServerFqdn,
    gzip: true,
    strictSSL: false,
    proxy: false,
    encoding: "utf8",
    resolveWithFullResponse: true,
    headers: {
        'x-access-token': process.env.CICD_BUILD_ACCESS_TOKEN
    }
});

const git = new Git({
    dir: path.resolve(__dirname, '../')
});

const getCommitId = function () {
    return new Promise((resolve) => {
        resolve(process.env.CICD_COMMIT_ID);
    }).then((commitId) => {
        if (commitId !== undefined)
            return commitId;

        return git.initialized().then((initialized) => {
            if (!initialized) {
                throw Error("Commit ID not found. This seems not to be a git repository.");
            }
        }).then(() => {
            return git.getLastCommitId();
        });
    });
}

describe("Execute ATF: Wrapper", function () {

    return getCommitId().then((commitId) => {
        //console.log('commitId', commitId);
        const sleepMs = 5000;
        let body;

        return promiseFor(function (nextOptions) {
            return (nextOptions);
        }, (options) => {
            //console.log('Request: ', options);
            return rpd(options).then((response) => {

                let location;
                if (response.statusCode === 202) { // job created, come back to url
                    location = response.headers.location;
                    if (!location)
                        throw Error('Location header not found');

                    delete options.body;
                    options.method = 'GET';
                    options.url = location;
                    // give it some time to start
                    return Promise.delay(sleepMs).then(() => {
                        return options;
                    });
                }

                options = null;
                body = response.body;

            }).catch((e) => {
                let location;
                if (e.statusCode === 304) { // job still running, wait and follow location
                    location = e.response.headers.location;
                    if (!location)
                        throw e;

                    delete options.body;
                    options.method = 'GET';
                    options.url = location;

                    //console.log(`Redirect to: ${options.url}`);
                    console.log(`Job in progress. Wait for ${sleepMs} ms ...`);
                    return Promise.delay(sleepMs).then(() => {
                        return options;
                    });
                } else {
                    throw e;
                }
            });
        }, {
                followRedirect: false,
                method: 'POST',
                url: ROUTE_TEST_EXECUTE,
                body: {
                    commitId: commitId,
                    on: process.env.CICD_RUN_TEST_ON_HOST
                }
            }).then(function () {
                console.log('Execute ATF: Wrapper');
                //console.log(body);
                return body;
            });

    }).then((response) => {

        const results = response.results;
        if (!results.suiteResults || !results.suiteResults)
            console.error(response);

        // { suiteResults: [ { testResults: [] } ], testResults: [] }

        if ((results.suiteResults.length === 0 || (results.suiteResults[0].testResults && results.suiteResults[0].testResults.length === 0)) && results.testResults.length === 0) {
            describe('Execute ATF: Execution Issue ', function () {
                it('>>>>> Passing for now, but no test cases specified!', function (done) {
                    expect([], "Please create test in ATF.").to.have.lengthOf(0);
                    done();
                });
            });
        }

        results.suiteResults.forEach((testExecutionResult) => {
            describe(`Test-Suite Result: "${testExecutionResult.number}"`, function () {

                it('Test-Suite Overall Result', function (done) {
                    addContext(this, testExecutionResult.url);
                    expect(testExecutionResult.status).to.equal('success');
                    done();
                });

                (testExecutionResult.testResults || []).forEach(function (testResult) {

                    describe(`Test Result: "${testResult.number}"`, function () {
                        testResult.stepResults.forEach(function (stepResult) {
                            it(`${stepResult.order} : ${stepResult.startTime} - ${stepResult.step}`, function (done) {
                                addContext(this, stepResult.url);
                                expect(stepResult.status).to.equal('success');
                                done();
                            });
                        });
                    });
                });

            });
        });
        results.testResults.forEach((testExecutionResult) => {
            describe(`Test Result: "${testExecutionResult.number}"`, function () {
                testExecutionResult.stepResults.forEach(function (stepResult) {
                    it(`${stepResult.order} : ${stepResult.startTime} - ${stepResult.step}`, function (done) {
                        addContext(this, stepResult.url);
                        expect(stepResult.status).to.equal('success');
                        done();
                    });
                });
            });
        });

    }).catch(function (e) {

        describe('Execute ATF: RuntimeError ', function () {
            it('Failed with', function (done) {
                console.error(e.error || e.message || e);
                expect.fail(0, 1, e.error || e.message || e); // force fail
                done();
            });
        });

    }).then(function () {
        console.log("execute Mocha Tests...");
        run();
    });
});
