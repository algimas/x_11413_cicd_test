/*eslint complexity: ["off", 24]*/
/*


Environment Variables used during deployment.
Variables can be defined in .env or set in the process context

CICD Server
    process.env.CICD_GULP_HOST_FQDN // https://server:4444
OR
    process.env.CICD_WEB_HTTPS_PORT // number or undefined
    process.env.CICD_WEB_HTTP_PORT  // number or undefined
    process.env.CICD_WEB_HOST_NAME  // server.company.com

Access token
    process.env.CICD_BUILD_ACCESS_TOKEN


CommitID 
    process.env.CICD_COMMIT_ID

ATF 
    process.env.CICD_RUN_TEST_ON_HOST       // the host on which to test

Deployment
    process.env.CICD_CD_DEPLOY_FROM_GIT     // deploy update set from git instead from a service now source environment
    process.env.CICD_DEPLOY_FROM            // optional
    process.env.CICD_DEPLOY_TO              // the target to deploy

    process.env.CICD_DELIVER_FROM           // optional
    process.env.CICD_DELIVER_TO             // the target to deliver

DEPLOY wins if CICD_DEPLOY_TO and CICD_DELIVER_TO are set

! WARNING !
if process.env.CICD_CD_STRICT_DEPLOYMENT is set to true on the CICD server, deployment target will be only taken from the server configuration.
look for 'CICD_CD_DEPLOYMENT_TARGET_ vars in .env

*/

require('dotenv').config();

const Promise = require('bluebird');
const gulp = require('gulp');
const jsdoc3 = require('gulp-jsdoc3');
const mocha = require('gulp-mocha');
const eslint = require('gulp-eslint');
const rename = require('gulp-rename');
const reporter = require('eslint-detailed-reporter');
const path = require('path');
const fs = require('fs-extra');
const archiver = require('archiver');
const gulpZip = require('gulp-zip');
const uui = require('uuid/v4');
const rp = require('request-promise');

const port = process.env.CICD_WEB_HTTPS_PORT || process.env.CICD_WEB_HTTP_PORT;
const cicdServerFqdn = process.env.CICD_GULP_HOST_FQDN || ((process.env.CICD_WEB_HOST_NAME) ? `${(process.env.CICD_WEB_HTTPS_PORT) ? 'https' : 'http'}://${process.env.CICD_WEB_HOST_NAME}:${port}` : null);

const Git = require('sn-project/lib/git');

const ROUTE_GULP_COMPLETE = '/build/complete';
const ROUTE_TASK_COMPLETE = '/build/task';
const ROUTE_BUILD_CONFIG = '/build/config';
const ROUTE_RUN_DEPLOY = '/deploy/us';

const arg = ((argList) => {
    let arg = {}, a, opt, thisOpt, curOpt;
    argList.forEach((thisOpt) => {
        thisOpt = (thisOpt) ? thisOpt.trim() : thisOpt;
        opt = thisOpt.replace(/^\-+/, '');
        if (opt === thisOpt) {
            if (curOpt)
                arg[curOpt] = opt;
            curOpt = null;
        } else {
            curOpt = opt;
            arg[curOpt] = true;
        }
    });
    return arg;

})(process.argv);

let config = {};
let taskError;

const promiseFor = Promise.method(function (condition, action, value) {
    if (!condition(value))
        return value;
    return action(value).then(promiseFor.bind(null, condition, action));
});

const git = new Git({
    dir: path.resolve(__dirname)
});

const rpd = rp.defaults({
    json: true,
    baseUrl: cicdServerFqdn,
    gzip: true,
    strictSSL: false,
    proxy: false,
    encoding: "utf8",
    headers: {
        'x-access-token': process.env.CICD_BUILD_ACCESS_TOKEN
    }
});


const onError = function (error) {
    taskError = error;
    //console.log(error);
    this.emit('end');
};

const buildDone = function () {
    //console.log("buildDone"); //, task, commitId);
    return rpd.post({
        url: ROUTE_GULP_COMPLETE, body: config
    }).then((results) => {
        console.log('Build Done:', results);
    });
};


const uploadResults = function ({ commitId, zip, task, testPass }) {
    /*console.log("Upload Results", {
        commitId: commitId,
        task: task,
        testPass: testPass ? 'true':'false'
    }); //, task, commitId);
    */
    return rpd.post({
        url: ROUTE_TASK_COMPLETE,
        formData: {
            zip: zip,
            data: JSON.stringify({
                commitId: commitId,
                task: task,
                testPass: testPass
            })
        }
    }).then((results) => {
        console.log("Upload Results", task, 'Upload successful!  Server responded with:', results);
    });
};

const taskStart = ({ task }) => {
    console.log(`### Starting Task '${task}'`);
    taskError = undefined;
};

const taskStop = ({ task }) => {

    console.log(`### Task Ended '${task}'`);

    const taskConfig = config[task];
    if (!taskConfig) {
        console.warn(`No config found for task '${task}'`);
        return;
    }
    if (taskError)
        console.warn(`WARN: Gulp failed on task '${task}'. Type: '${taskError.name}', Message: '${taskError.message}'`);

    taskConfig.task = task;
    taskConfig.testPass = (taskError) ? false : true;

    return zip(taskConfig).then((zipFile) => {
        return uploadResults({
            zip: fs.createReadStream(zipFile),
            commitId: config.commitId,
            task: taskConfig.task,
            testPass: taskConfig.testPass
        }).then(() => {
            console.log(`Remove file '${zipFile}'`);
            return fs.remove(zipFile);
        });
    }).then(() => {
        console.log(`Remove file '${taskConfig.dir}'`);
        return fs.remove(taskConfig.dir);
    }).catch((e) => {
        console.error(e.message || e);
    });
};

const zip = function ({ dir, task }) {
    return new Promise((resolve, reject) => {
        if (!dir)
            reject(`Gulp task '${task}' has no directory`);

        const output = fs.createWriteStream(path.join(dir, '../', `${task}.zip`));
        output.on('close', function () {
            console.log("ZIP:", task, archive.pointer() + ' total bytes');
            console.log("ZIP:", task, 'archiver has been finalized and the output file descriptor has closed.');
            resolve(path.join(dir, '../', `${task}.zip`));
        });

        const archive = archiver('zip', {
            zlib: {
                level: 9
            }
        });
        archive.pipe(output);

        console.log("ZIP:", task, "adding folder ", dir);

        archive.directory(dir, false);
        archive.finalize();
    });

};

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

gulp.task('default', function () {

    gulp.on('task_start', taskStart);
    gulp.on('task_stop', taskStop);
    /*
    
    gulp.on('err', function (e) {
        console.log('err', e);
    });
    gulp.on('task_err', function (e) {
        console.log('task_err', e);
    });
    */

    if (!cicdServerFqdn)
        throw Error('CICD Server endpoint not set. Use CICD_GULP_HOST_FQDN or CICD_WEB_HTTP(S)_PORT and CICD_WEB_HOST_NAME env variables');

    if (!process.env.CICD_BUILD_ACCESS_TOKEN)
        throw Error('CICD_BUILD_ACCESS_TOKEN env not set');

    console.log(`\n${'* '.repeat(42)}\n\tCICD Endpoint: ${cicdServerFqdn}\n${'* '.repeat(42)}\n`);

    return getCommitId().then((commitId) => {

        //console.log('commitId', commitId);

        return rpd.get(`${ROUTE_BUILD_CONFIG}/${commitId}`).then((buildConfig) => ({
            commitId: commitId, buildConfig: buildConfig
        }));
    }).then(({ commitId, buildConfig }) => {

        config = buildConfig;
        config.commitId = commitId;

        const preLint = ['init'];
        const preDoc = (config.lint && config.lint.enabled !== false) ? ['lint'] : ['init'];
        const preTest = (config.doc && config.doc.enabled !== false) ? ['doc'] : (config.lint && config.lint.enabled !== false) ? ['lint'] : ['init'];
        const preBuild = (config.test && config.test.enabled !== false) ? ['test'] : (config.doc && config.doc.enabled !== false) ? ['doc'] : (config.lint && config.lint.enabled !== false) ? ['lint'] : ['init'];

        const tempDir = require('os').tmpdir();
        const uuid = uui();

        config.tempDir = path.join(tempDir, uuid);
        config.lint.dir = path.join(tempDir, uuid, 'lint');
        config.doc.dir = path.join(tempDir, uuid, 'doc');
        config.test.dir = path.join(tempDir, uuid, 'test');

        //console.log(config);

        gulp.task('init', function () {
            if (!config.init)
                throw Error(`Build config not complete: ${config}`);

            try {
                fs.mkdirpSync(config.doc.dir);
                fs.mkdirpSync(config.lint.dir);
                fs.mkdirpSync(config.test.dir);
            } catch (e) {
                onError.call(this, e);
            }
        });

        if (config.lint && config.lint.enabled !== false)
            gulp.task('lint', preLint, function () {

                var self = this;
                var esLintReport = path.resolve(config.lint.dir, 'index.html');
                console.log('EsLint to destination:', esLintReport);

                // ESLint ignores files with "node_modules" paths.
                // So, it's best to have gulp ignore the directory as well.
                // Also, Be sure to return the stream from the task;
                // Otherwise, the task may end before the stream has finished.
                return gulp.src(config.lint.files.concat('!node_modules/**'))
                    // eslint() attaches the lint output to the "eslint" property
                    // of the file object so it can be used by other modules.
                    .pipe(eslint(config.lint.config))
                    // eslint.format() outputs the lint results to the console.
                    // Alternatively use eslint.formatEach() (see Docs).
                    .pipe(eslint.format(reporter, function (results) {
                        fs.writeFileSync(esLintReport, results);
                    }))
                    // To have the process exit with an error code (1) on
                    // lint error, return the stream and pipe to failAfterError last.
                    //.pipe(eslint.failAfterError());

                    .pipe(eslint.failAfterError())
                    .on('error', onError);

            });


        if (config.doc && config.doc.enabled !== false)
            gulp.task('doc', preDoc, function (done) {
                config.doc.config.opts.destination = config.doc.dir;
                console.log('JsDoc to destination:', config.doc.config.opts.destination);
                gulp.src(['README.md', './sn/**/*.js', './sn/**/*.jsdoc'], {
                    read: false
                }).pipe(jsdoc3(config.doc.config, function () {
                    done();
                })).on('error', onError);
            });

        if (config.test && config.test.enabled !== false)
            gulp.task('test', preTest, function () {
                return gulp.src(['test/*.js'], {
                    read: false
                }).pipe(mocha({
                    reporter: 'mochawesome', // 'xunit' 'spec'
                    reporterOptions: {
                        reportDir: config.test.dir,
                        reportFilename: 'index.html',
                        reportTitle: config.test.title,
                        reportPageTitle: 'ATF Results',
                        quiet: true,
                        json: true,
                        inline: false,
                        code: false
                    },
                    timeout: 30000,
                    delay: true
                })).on('error', onError);
            });

        gulp.task('build', preBuild, buildDone);

    }).then(() => {
        gulp.start('build');
    }).catch((e) => {
        console.error(e);
        // let the process know something is wrong
        throw e;
    });

});


/**
 * from a standard build tool run 'gulp test' to only run the test 
 * this task requires the following args or environment variables to be in place
 *      --commit-id OR process.env.CICD_COMMIT_ID
 *      --on-host OR process.env.CICD_RUN_TEST_ON_HOST
 */
gulp.task('test', function () {

    if (arg['on-host'])
        process.env.CICD_RUN_TEST_ON_HOST = arg['on-host'];

    if (arg['commit-id'])
        process.env.CICD_COMMIT_ID = arg['commit-id'];

    if (!process.env.CICD_COMMIT_ID)
        throw Error('CICD_COMMIT_ID is required');

    if (!cicdServerFqdn)
        throw Error('CICD Server endpoint not set. Use CICD_GULP_HOST_FQDN or CICD_WEB_HTTP(S)_PORT and CICD_WEB_HOST_NAME env variables');

    console.log(`Gulp Task [TEST] - commit-id: ${process.env.CICD_COMMIT_ID}; on-host: ${process.env.CICD_RUN_TEST_ON_HOST}`)

    return gulp.src(['test/*.js'], {
        read: false
    }).pipe(mocha({
        reporter: 'xunit',
        reporterOptions: {
            output: 'test-results.xml'
        },
        timeout: 30000,
        delay: true
    }));
});


/**
 * use 'gulp deploy' if you dont want to write an custom client
 * to call the /deploy/us endpoint
 */
gulp.task('deploy', function () {

    const commitId = arg['commit-id'] || process.env.CICD_COMMIT_ID;
    if (!commitId)
        throw Error('CICD_COMMIT_ID is required');

    const git = arg['git'] || Boolean(process.env.CICD_CD_DEPLOY_FROM_GIT === 'true');
    const deploy = Boolean(arg['deploy-to'] || process.env.CICD_DEPLOY_TO);
    const deliver = Boolean(arg['deliver-to'] || process.env.CICD_DELIVER_TO)

    const from = deploy ? arg['deploy-from'] || process.env.CICD_DEPLOY_FROM : arg['deliver-from'] || process.env.CICD_DELIVER_FROM;
    const to = deploy ? arg['deploy-to'] || process.env.CICD_DEPLOY_TO : arg['deliver-to'] || process.env.CICD_DELIVER_TO;

    return Promise.try(() => {
        if (!deploy && !deliver)
            throw Error('--deploy-to, CICD_DEPLOY_TO and --deliver-to, CICD_DELIVER_TO found');

        if (!cicdServerFqdn)
            throw Error('CICD Server endpoint not set. Use CICD_GULP_HOST_FQDN or CICD_WEB_HTTP(S)_PORT and CICD_WEB_HOST_NAME env variables');


        console.log(`Gulp Task [DEPLOY] - commit-id: ${commitId}; via-git: ${git}, from: ${from}; to: ${to}`);

    }).then(() => {
        const sleepMs = 5000;
        let body = {};

        if (!process.env.CICD_DEPLOY_ACCESS_TOKEN)
            throw Error('CICD_DEPLOY_ACCESS_TOKEN env not set');

        const client = rpd.defaults({
            resolveWithFullResponse: true,
            followRedirect: false,
            headers: {
                'x-access-token': process.env.CICD_DEPLOY_ACCESS_TOKEN,
            }
        });

        return promiseFor((options) => (options),
            (options) => {
                return client(options).then((response) => {
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

                        console.log(`Job in progress. Wait for ${sleepMs} ms ...`);
                        return Promise.delay(sleepMs).then(() => {
                            return options;
                        });
                    } else {
                        throw e;
                    }
                });
            }, {
                url: ROUTE_RUN_DEPLOY,
                method: 'POST',
                body: {
                    commitId,
                    from,
                    to,
                    deploy,
                    git
                }
            }
        ).then(function () {
            if (body.state !== 'completed') {
                console.error('body.state is not completed', body);
                throw Error(body.state);
            }

            console.log(`Deployment Results:\n\tType: ${body.type} \n\tState: ${body.state} \n\tDuration: ${body.end - body.start}ms \n\tFrom: ${body.from} \n\tTo: ${body.to}`);
        })
    }).catch((e) => {
        console.error('Deployment Failed', e)
        throw Error(e);
    });




})

/**
 * use 'gulp artifact' to create zip files of the current update set and the whole app
 */

var clean = require('gulp-rimraf');

gulp.task('clean-artifact', function () {
    return gulp.src('dist', { read: false })
        .pipe(clean());
});
gulp.task('artifact-app', function () {
    console.log(`creating application artifact`);
    return gulp.src('us/**/*')
        .pipe(gulpZip('app.zip'))
        .pipe(gulp.dest('dist', { overwrite: true }));
});

gulp.task('artifact-us', function (done) {
    getCommitId()
        .then((commitId) => {
            return rpd.get(`${ROUTE_BUILD_CONFIG}/${commitId}`);
        })
        .then((buildConfig) => {
            const artifact = path.resolve(buildConfig.artifact)
            console.log(`preparing artifact of ${artifact}`);
            if (artifact)
                return gulp.src(artifact)
                    .pipe(rename('artifact.xml'))
                    .pipe(gulp.dest('dist', { overwrite: true }));
        }).then(() => {
            return done();
        }).catch((e) => {
            console.error(e);
            // let the process know something is wrong
            throw e;
        });
});

gulp.task('artifact', ['clean-artifact', 'artifact-us', 'artifact-app'], function () {
    console.log(`creating release artifact`);
});
