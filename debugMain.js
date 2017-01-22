'use strict'
const {
	DebugSession,
	InitializedEvent, ExitedEvent, TerminatedEvent, StoppedEvent, BreakpointEvent, OutputEvent, Event,
	Thread, StackFrame, Scope, Source, Handles, Breakpoint } = require('vscode-debugadapter');
const DebugProtocol = { //require('vscode-debugprotocol');
    /** Arguments for 'launch' request. */
    LaunchRequestArguments: class {
		/** If noDebug is true the launch request should launch the program without enabling debugging. */
        get noDebug() { return false }
	}
}
// node and external modules
const crypto = require('crypto');
const dom = require('xmldom').DOMParser;
const fs = require('fs');
const path = require('path');
const xpath = require('xpath');
// our stuff
const { ADBClient } = require('./adbclient');
const { Debugger } = require('./debugger');
const $ = require('./jq-promise');
const { D, isEmptyObject } = require('./util');
const ws_proxy = require('./wsproxy').proxy.Server(6037, 5037);

// arbitrary precision helper class for 64 bit numbers
const NumberBaseConverter = {
    // Adds two arrays for the given base (10 or 16), returning the result.
    add(x, y, base) {
        var z = [], n = Math.max(x.length, y.length), carry = 0, i = 0;
        while (i < n || carry) {
            var xi = i < x.length ? x[i] : 0;
            var yi = i < y.length ? y[i] : 0;
            var zi = carry + xi + yi;
            z.push(zi % base);
            carry = Math.floor(zi / base);
            i++;
        }
        return z;
    },
    // Returns a*x, where x is an array of decimal digits and a is an ordinary
    // JavaScript number. base is the number base of the array x.
    multiplyByNumber(num, x, base) {
        if (num < 0) return null;
        if (num == 0) return [];
        var result = [], power = x;
        for(;;) {
            if (num & 1) {
            result = this.add(result, power, base);
            }
            num = num >> 1;
            if (num === 0) return result;
            power = this.add(power, power, base);
        }
    },
    twosComplement(str, base) {
        const invdigits = str.split('').map(c => 15 - parseInt(c,base)).reverse();
        const negdigits = this.add(invdigits, [1], base).slice(0,str.length);
        return negdigits.reverse().map(d => d.toString(base)).join('');
    },
    convertBase(str, fromBase, toBase) {
        var digits = str.split('').map(d => parseInt(d,fromBase)).reverse();
        var outArray = [], power = [1];
        for (var i = 0; i < digits.length; i++) {
            if (digits[i]) {
                outArray = this.add(outArray, this.multiplyByNumber(digits[i], power, toBase), toBase);
            }
            power = this.multiplyByNumber(fromBase, power, toBase);
        }
        return outArray.reverse().map(d => d.toString(toBase)).join('');
    },
    hexToDec(hexstr, signed) {
        var res, isneg = /^[^0-7]/.test(hexstr);
        if (hexstr.match(/^0*(.+)$/)[1].length*4 < 52) {
            // less than 52 bits - just use parseInt
            res = parseInt(hexstr, 16);
            if (signed && isneg) res = -res;
            return res.toString(10);
        }
        if (isneg) {
            hexstr = NumberBaseConverter.twosComplement(hexstr, 16);
        }
        res = (isneg ? '-' : '') + NumberBaseConverter.convertBase(hexstr, 16, 10);
        return res;
    },
};

// some commonly used Java types in debugger-compatible format
const JTYPES = {
    byte: {name:'int',signature:'B'},
    short: {name:'short',signature:'S'},
    int: {name:'int',signature:'I'},
    long: {name:'long',signature:'J'},
    float: {name:'float',signature:'F'},
    double: {name:'double',signature:'D'},
    char: {name:'char',signature:'C'},
    boolean: {name:'boolean',signature:'Z'},
    null: {name:'null',signature:'Lnull;'},   // null has no type really, but we need something for literals
    String: {name:'String',signature:'Ljava/lang/String;'},
    Object: {name:'Object',signature:'Ljava/lang/Object;'},
    isArray(t) { return t.signature[0]==='[' },
    isObject(t) { return t.signature[0]==='L' },
    isReference(t) { return /^[L[]/.test(t.signature) },
    isPrimitive(t) { return !JTYPES.isReference(t.signature) },
    isInteger(t) { return /^[BIJS]$/.test(t.signature) },
}

function ensure_path_end_slash(p) {
    return p + (/[\\/]$/.test(p) ? '' : path.sep);
}

class AndroidDebugSession extends DebugSession {

	/**
	 * Creates a new debug adapter that is used for one debug session.
	 */
    constructor() {
        super();
        // create the Android debugger instance - we proxy requests through this
        this.dbgr = new Debugger();

        // the base folder of the app (where AndroidManifest.xml and source files should be)
        this.app_src_root = '<no appSrcRoot>';
        // the filepathname of the built apk
        this.apk_fpn = '';
        // the apk file content
        this._apk_file_data = null;
        // the file info, hash and manifest data of the apk
        this.apk_file_info = {};
        // hashmap of packages we found in the source tree
        this.src_packages = {};
        // the device we are debugging
        this._device = null;
        // expandable primitives
        this._expandable_prims = false;
        // true if the app is resumed, false if stopped (exception, breakpoint, etc)
        this._running = false;
        // a promise to wait on for the stack variables to evaluate
        this._locals_done = null;
        // the fifo queue of evaluations (watches, hover, etc)
        this._evals_queue = [];

        // since we want to send breakpoint events, we will assign an id to every event
        // so that the frontend can match events with breakpoints.
        this._breakpointId = 1000;

        // hashmap of variables and frames
        this._variableHandles = {};
        this._frameBaseId  =  0x00010000; // high, so we don't clash with thread id's
        this._nextObjVarRef = 0x10000000; // high, so we don't clash with thread or frame id's

        // flag to distinguish unexpected disconnection events (initiated from the device) vs user-terminated requests
        this._isDisconnecting = false;

		// this debugger uses one-based lines and columns
		this.setDebuggerLinesStartAt1(true);
		this.setDebuggerColumnsStartAt1(true);
    }

	/**
	 * The 'initialize' request is the first request called by the frontend
	 * to interrogate the features the debug adapter provides.
	 */
	initializeRequest(response/*: DebugProtocol.InitializeResponse*/, args/*: DebugProtocol.InitializeRequestArguments*/) {

		// This debug adapter implements the configurationDoneRequest.
		response.body.supportsConfigurationDoneRequest = true;

		this.sendResponse(response);
	}

    LOG(msg) {
        D(msg);
        this.sendEvent(new OutputEvent(msg));
    }

    WARN(msg) {
        D(msg = 'Warning: '+msg);
        this.sendEvent(new OutputEvent(msg));
    }

    failRequest(msg, response) {
        // yeah, it can happen sometimes...
        this.WARN(msg);
        if (response) {
            response.success = false;
            this.sendResponse(response);
        }
    }

	launchRequest(response/*: DebugProtocol.LaunchResponse*/, args/*: LaunchRequestArguments*/) {

        try { D('Launching: ' + JSON.stringify(args)); } catch(ex) {}
        // app_src_root must end in a path-separator for correct validation of sub-paths
        this.app_src_root = ensure_path_end_slash(args.appSrcRoot);
        this.apk_fpn = args.apkFile;

        // configure the ADB port - if it's undefined, it will set the default value.
        // if it's not a valid port number, any connection request should neatly fail.
        ws_proxy.setADBPort(args.adbPort);

        try {
            // start by scanning the source folder for stuff we need to know about (packages, manifest, etc)
            this.src_packages = this.scanSourceSync(this.app_src_root);
            // warn if we couldn't find any packages (-> no source -> cannot debug anything)
            if (isEmptyObject(this.src_packages.packages))
                this.WARN('No source files found. Check the "appSrcRoot" setting in launch.json');

        } catch(err) {
            // wow, we really didn't make it very far...
            this.LOG(err.message);
            this.LOG('Check the "appSrcRoot" and "apkFile" entries in launch.json');
            this.sendEvent(new TerminatedEvent(false));
            return;
        }

        var fail_launch = (msg) => $.Deferred().rejectWith(this, [new Error(msg)]);

        this.LOG('Checking build')
        this.getAPKFileInfo()
            .then(apk_file_info => {
                this.apk_file_info = apk_file_info;
                // check if any source file was modified after the apk
                if (this.src_packages.last_src_modified >= this.apk_file_info.app_modified) {
                    switch (args.staleBuild) {
                        case 'ignore': break;
                        case 'stop': return fail_launch('Build is not up-to-date');
                        case 'warn': 
                        default: this.WARN('Build is not up-to-date. Source files may not match execution when debugging.'); break;
                    }
                }
                // check we have something to launch - we do this again later, but it's a bit better to do it before we start device comms
                var launchActivity = args.launchActivity;
                if (!launchActivity)
                    if (!(launchActivity = this.apk_file_info.launcher))
                        return fail_launch('No valid launch activity found in AndroidManifest.xml or launch.json');
                return this.findSuitableDevice(args.targetDevice);
            })
            .then(device => {
                this._device = device;
                this._device.adbclient = new ADBClient(this._device.serial);
                // we've got our device - retrieve the hash of the installed app (or sha1 utility itself if the app is not installed)
                const query_app_hash = `/system/bin/sha1sum $(pm path ${this.apk_file_info.package}|grep -o -e '/.*' || echo '/system/bin/sha1sum')`;
                return this._device.adbclient.shell_cmd({command: query_app_hash});
            })
            .then(sha1sum_output => {
                const installed_hash = sha1sum_output.match(/^[0-9a-fA-F]*/)[0].toLowerCase();
                // does the installed apk hash match the content hash? if, so we don't need to install the app
                if (installed_hash === this.apk_file_info.content_hash) {
                    this.LOG('Current build already installed');
                    return;
                }
                return this.copyAndInstallAPK();
            })
            .then(() => {
                // when we reach here, the app should be installed and ready to be launched
                // - before we continue, splunk the apk file data because node *still* hangs when evaluating large arrays
                this._apk_file_data = null;

                // start the launch
                var launchActivity = args.launchActivity;
                if (!launchActivity)
                    if (!(launchActivity = this.apk_file_info.launcher))
                        return fail_launch('No valid launch activity found in AndroidManifest.xml or launch.json');
                var build = {
                    pkgname:this.apk_file_info.package, 
                    packages:Object.assign({}, this.src_packages.packages),
                    launchActivity: launchActivity,
                };
                this.LOG(`Launching ${build.pkgname+'/'+launchActivity} on device ${this._device.serial}`);
                return this.dbgr.startDebugSession(build, this._device.serial, launchActivity);
            })
            .then(() => {
                // if we get this far, the debugger is connected and waiting for the resume command
                // - set up some events
                this.dbgr.on('bpstatechange', this, this.onBreakpointStateChange)
                    .on('bphit', this, this.onBreakpointHit)
                    .on('step', this, this.onStep)
                    .on('disconnect', this, this.onDebuggerDisconnect);
                this.waitForConfigurationDone = $.Deferred();
                // - tell the client we're initialised and ready for breakpoint info, etc
                this.sendEvent(new InitializedEvent());
                return this.waitForConfigurationDone;
            })
            .then(() => {
                // config is done - we're all set and ready to go!
                D('Continuing app start');
                this.continueRequest(response, {is_start:true});
            })
            .fail(e => {
                // exceptions use message, adbclient uses msg
                this.LOG('Launch failed: '+(e.message||e.msg||'No additional information is available'));
                // more info for adb connect errors
                if (/^ADB server is not running/.test(e.msg)) {
                    this.LOG('Make sure the Android SDK tools are installed and run:');
                    this.LOG('      adb start-server');
                    this.LOG('If you are running ADB on a non-default port, also make sure the adbPort value in your launch.json is correct.');
                }
                // tell the client we're done
                this.sendEvent(new TerminatedEvent(false));
            });
	}

    copyAndInstallAPK() {
        // copy the file to the device
        this.LOG('Deploying current build...');
        return this._device.adbclient.push_file({
            filepathname:'/data/local/tmp/debug.apk',
            filedata:this._apk_file_data,
            filemtime:new Date().getTime(),
        })
        .then(() => {
            // send the install command
            this.LOG('Installing...');
            return this._device.adbclient.shell_cmd({
                command:'pm install -r /data/local/tmp/debug.apk',
                untilclosed:true,
            })
        })
        .then((stdout) => {
            // failures:
            // 	       pkg: x-y-z.apk
            //  Failure [INSTALL_FAILED_OLDER_SDK]
            var m = stdout.match(/Failure\s+\[([^\]]+)\]/g);
            if (m) {
                return $.Deferred().rejectWith(this, [new Error('Installation failed. ' + m[0])]);
            }
        })
    }

    getAPKFileInfo() {
        var done = $.Deferred();
        done.result = { fpn:this.apk_fpn, app_modified:0, content_hash:'', manifest:'', package:'', activities:[], launcher:'' };
        // read the APK
        fs.readFile(this.apk_fpn, (err,apk_file_data) => {
            if (err) return done.rejectWith(this, [new Error('APK read error. ' + err.message)]);
            // debugging is painful when the APK file content is large, so keep the data in a separate field so node
            // doesn't have to evaluate it when we're looking at the apk info
            this._apk_file_data = apk_file_data;
            // save the last modification time of the app
            done.result.app_modified = fs.statSync(done.result.fpn).mtime.getTime();
            // create a SHA-1 hash as a simple way to see if we need to install/update the app
            const h = crypto.createHash('SHA1');
            h.update(apk_file_data);
            done.result.content_hash = h.digest('hex');
            // read the manifest
            fs.readFile(path.join(this.app_src_root,'AndroidManifest.xml'), 'utf8', (err,manifest) => {
                if (err) return done.rejectWith(this, [new Error('Manifest read error. ' + err.message)]);
                done.result.manifest = manifest;
                try {
                    const doc = new dom().parseFromString(manifest);
                    // extract the package name from the manifest
                    const pkg_xpath = '/manifest/@package';
                    done.result.package = xpath.select1(pkg_xpath, doc).value;
                    const android_select = xpath.useNamespaces({"android": "http://schemas.android.com/apk/res/android"});
                    // extract a list of all the (named) activities declared in the manifest
        			const activity_xpath='/manifest/application/activity/@android:name';
                    var nodes = android_select(activity_xpath, doc);
                    nodes && (done.result.activities = nodes.map(n => n.value));

                    // extract the default launcher activity
        			const launcher_xpath='/manifest/application/activity[intent-filter/action[@android:name="android.intent.action.MAIN"] and intent-filter/category[@android:name="android.intent.category.LAUNCHER"]]/@android:name';
                    var nodes = android_select(launcher_xpath, doc);
                    // should we warn if there's more than one?
                    if (nodes && nodes.length >= 1)
                        done.result.launcher = nodes[0].value
                } catch(err) {
                    return done.rejectWith(this, [new Error('Manifest parse failed. ' + err.message)]);
                }
                done.resolveWith(this, [done.result]);
            });
        });
        return done;
    }
    
    scanSourceSync(app_root) {
        try {
            // scan known app folders looking for file changes and package folders
            var p, paths = fs.readdirSync(app_root,'utf8'), done=[];
            var src_packages = {
                last_src_modified: 0,
                packages: {},
            };
            while (paths.length) {
                p = paths.shift();
                // just in case someone has some crazy circular links going on
                if (done.indexOf(p)>=0) continue;
                done.push(p);
                var subfiles = [], stat, fpn = path.join(app_root,p);
                try {
                    stat = fs.statSync(fpn);
                    src_packages.last_src_modified = Math.max(src_packages.last_src_modified, stat.mtime.getTime());
                    if (!stat.isDirectory()) continue;
                    subfiles = fs.readdirSync(fpn, 'utf8');
                }
                catch (err) { continue }
                // ignore folders not starting with a known top-level Android folder
                if (!/^(assets|res|src|main|java)([\\/]|$)/.test(p)) continue;
                // is this a package folder
                var pkgmatch = p.match(/^(src|main|java)[\\/](.+)/);
                if (pkgmatch && /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(pkgmatch[2].split(/[\\/]/).pop())) {
                    // looks good - add it to the list
                    const src_folder = pkgmatch[1]; // src, main or java
                    const pkgname = pkgmatch[2].replace(/[\\/]/g,'.');
                    src_packages.packages[pkgname] = {
                        package: pkgname,
                        package_path: fpn,
                        srcroot: path.join(app_root,src_folder),
                    }
                }
                // add the subfiles to the list to process
                paths = subfiles.map(sf => path.join(p,sf)).concat(paths);
            }
            return src_packages;
        } catch(err) {
            throw new Error('Source path error: ' + err.message);
        }
    }

    findSuitableDevice(target_deviceid) {
        this.LOG('Searching for devices...');
        return this.dbgr.list_devices()
            .then(devices => {
                this.LOG(`Found ${devices.length} device${devices.length===1?'':'s'}`);
                var reject;
                if (devices.length === 0) {
                    reject = 'No devices are connected';
                } else if (target_deviceid) {
                    // check (only one of) the requested device is present
                    var matching_devices = devices.filter(d => d.serial === target_deviceid);
                    switch(matching_devices.length) {
                        case 0: reject = `Target device: '${target_deviceid}' is not connected. Connect it or specify an alternate target device in launch.json`; break;
                        case 1: return matching_devices[0];
                        default: reject = `Target device: '${target_deviceid}' has multiple candidates. Connect a single device or specify an alternate target device in launch.json`; break;
                    }
                } else if (devices.length === 1) {
                    // no specific target device and only one device is connected to adb - use it
                    return devices[0];
                } else {
                    // more than one device and no specific target - fail the launch
                    reject = `Multiple devices are connected and no target device is specified in launch.json`;
                    // be nice and list the devices so the user can easily configure
                    devices.forEach(d => this.LOG(`\t${d.serial}\t${d.status}`));
                }
                return $.Deferred().rejectWith(this, [new Error(reject)]);
            })
    }

    configurationDoneRequest(response, args) {
        this.waitForConfigurationDone.resolve();
        this.sendResponse(response);
    }

    onDebuggerDisconnect() {
        // called when we manually disconnect, or from an unexpected disconnection (USB cable disconnect, etc)
        if (!this._isDisconnecting) {
            D('Unexpected disconnection');
            // this is a surprise disconnect (initiated from the device) - tell the client we're done
            this.LOG(`Device disconnected`);
            this.sendEvent(new TerminatedEvent(false));
        }
    }

    disconnectRequest(response, args) {
        D('disconnectRequest');
        this._isDisconnecting = true;
        // if we're connected, ask ADB to terminate the app
        if (this.dbgr.status() === 'connected')
            this.dbgr.forcestop();
        return this.dbgr.disconnect(response)
            .then((state, response) => {
                if (/^connect/.test(state))
                    this.LOG(`Debugger disconnected`);
                this.sendResponse(response);
                //this.sendEvent(new ExitedEvent(0));
            })
    }

    onBreakpointStateChange(e) {
        e.breakpoints.forEach(javabp => {
            // if there's no associated vsbp we're deleting it, so just ignore the update
            if (!javabp.vsbp) return;
            var verified = !!javabp.state.match(/set|enabled/);
            javabp.vsbp.verified = verified;
            this.sendEvent(new BreakpointEvent('updated', javabp.vsbp));
        });
    }

    onBreakpointHit(e) {
        D('Breakpoint hit: ' + JSON.stringify(e.stoppedlocation));
        this._running = false;
        var tid = parseInt(e.stoppedlocation.threadid,16);
        this.sendEvent(new StoppedEvent("breakpoint", tid));
    }

    markAllThreadsStopped(reason, exclude) {
        this.dbgr.allthreads(reason)
            .then(threads => {
                if (Array.isArray(exclude))
                    threads = threads.filter(t => !exclude.includes(t));
                threads.forEach(t => this.sendEvent(new StoppedEvent(reason, parseInt(t,16))));
            });
    }

    /**
     * Called when the user requests a change to breakpoints in a source file
     * Note: all breakpoints in a file are always sent in args, even if they are not changing
     */
	setBreakPointsRequest(response/*: DebugProtocol.SetBreakpointsResponse*/, args/*: DebugProtocol.SetBreakpointsArguments*/) {
		var srcfpn = args.source && args.source.path;
		var clientLines = args.lines;
        D('setBreakPointsRequest: ' + srcfpn);

        // the file must lie inside one of the source packages we found (and it must be have a .java extension)
        var srcfolder = path.dirname(srcfpn);
        var pkginfo;
        for (var pkg in this.src_packages.packages) {
            if ((pkginfo = this.src_packages.packages[pkg]).package_path === srcfolder) break;
            pkginfo = null;
        }
        if (!pkginfo || !/\.java$/.test(srcfpn)) {
            // source file is not a java file or is outside of the known source packages
            // just send back a list of unverified breakpoints
            response.body = {
                breakpoints: args.lines.map(l => {
                    var bp = new Breakpoint(false,l);
                    bp.id = ++this._breakpointId;
                    return bp;
                })
            };
    		this.sendResponse(response);
            return;
        }

        // our debugger requires a relative fpn beginning with / , rooted at the java source base folder
        // - it should look like: /some/package/name/abc.java
        var relative_fpn = srcfpn.slice(pkginfo.srcroot.length);

        // delete any existing breakpoints not in the list
        this.dbgr.clearbreakpoints(javabp => {
            var remove = javabp.srcfpn===relative_fpn && !clientLines.includes(javabp.linenum);
            if (remove) javabp.vsbp = null;
            return remove;
        });

        // return the list of new and existing breakpoints
        var breakpoints = clientLines.map((line,idx) => {
            var dbgline = this.convertClientLineToDebugger(line);
            var javabp = this.dbgr.setbreakpoint(relative_fpn, dbgline);
            if (!javabp.vsbp) {
                // state is one of: set,notloaded,enabled,removed
                var verified = !!javabp.state.match(/set|enabled/);
                const bp = new Breakpoint(verified, this.convertDebuggerLineToClient(dbgline));
                // the breakpoint *must* have an id field or it won't update properly
                bp.id = ++this._breakpointId;
                javabp.vsbp = bp;
            }
            javabp.vsbp.order = idx;
			return javabp.vsbp;
        });

		// send back the actual breakpoint positions
		response.body = {
			breakpoints: breakpoints
		};
		this.sendResponse(response);
	}

	threadsRequest(response/*: DebugProtocol.ThreadsResponse*/) {

        this.dbgr.allthreads(response)
            .then((threads, response) => {
                // convert the (hex) thread strings into real numbers
                var tids = threads.map(t => parseInt(t,16));
                response.body = {
                    threads: tids.map(tid => new Thread(tid, `Thread (id:${tid})`))
                };
                this.sendResponse(response);
            })
            .fail(e => {
                response.success = false;
                this.sendResponse(response);
            });
	}

	/**
	 * Returns a stack trace for the given threadId
	 */
	stackTraceRequest(response/*: DebugProtocol.StackTraceResponse*/, args/*: DebugProtocol.StackTraceArguments*/) {

        // debugger threadid's are a padded 64bit hex number
        var threadid = ('000000000000000' + args.threadId.toString(16)).slice(-16);
        // retrieve the (stack) frames from the debugger
        this.dbgr.getframes(threadid, {response:response, args:args})
            .then((frames, x) => {
                // first ensure that the line-tables for all the methods are loaded
                var defs = frames.map(f => this.dbgr._ensuremethodlines(f.method));
                defs.unshift(frames,x);
                return $.when.apply($,defs);
            })
            .then((frames, x) => {
                const startFrame = typeof x.args.startFrame === 'number' ? x.args.startFrame : 0;
                const maxLevels = typeof x.args.levels === 'number' ? x.args.levels : frames.length-startFrame;
                const endFrame = Math.min(startFrame + maxLevels, frames.length);
                var stack = [], totalFrames = frames.length, highest_known_source=0;
                for (var i= startFrame; i < endFrame; i++) {
                    // the stack_frame_id must be unique across all threads
                    const stack_frame_id = (x.args.threadId * this._frameBaseId) + i;
                    this._variableHandles[stack_frame_id] = { varref: stack_frame_id, frame: frames[i], threadId:x.args.threadId };
                    const name = `${frames[i].method.owningclass.name}.${frames[i].method.name}`;
                    const pkginfo = this.src_packages.packages[frames[i].method.owningclass.type.package];
                    const sourcefile = frames[i].method.owningclass.src.sourcefile;
                    const srcloc = this.dbgr.line_idx_to_source_location(frames[i].method, frames[i].location.idx);
                    if (!srcloc) {
                        totalFrames--;
                        continue;  // ignore frames which have no location (they're probably synthetic)
                    }
                    const linenum = srcloc && this.convertDebuggerLineToClient(srcloc.linenum);
                    const src = sourcefile && new Source(sourcefile, (pkginfo && path.join(pkginfo.package_path,sourcefile))||'', pkginfo ? 0 : 1);
                    pkginfo && (highest_known_source=i);
                    stack.push(new StackFrame(stack_frame_id, name, src, linenum, 0));
                }
                // FIX: trim the stack to exclude anything above the known sources - otherwise an error occurs in the editor when the user tries to view it
                stack = stack.slice(0,highest_known_source+1);
                totalFrames = stack.length;
                // return the frames
                response.body = {
                    stackFrames: stack,
                    totalFrames: totalFrames,
                };
                this.sendResponse(response);
            });
	}

	scopesRequest(response/*: DebugProtocol.ScopesResponse*/, args/*: DebugProtocol.ScopesArguments*/) {

		response.body = {
			scopes: [new Scope("Local", args.frameId, false)]
		};
		this.sendResponse(response);
	}

    sourceRequest(response/*: DebugProtocol.SourceResponse*/, args/*: DebugProtocol.SourceArguments*/) {
        response.body = { content:'// The source for this class is unavailable.' }
        this.sendResponse(response);
    }

    /**
     * Converts locals (or other vars) in debugger format into Variable objects used by VSCode
     */
    _locals_to_variables(vars) {
        return vars.map(v => {
            var varref = 0, objvalue, typename = v.type.package ? `${v.type.package}.${v.type.typename}` : v.type.typename;
            switch(true) {
                case v.hasnullvalue && JTYPES.isReference(v.type):
                    // null object or array type
                    objvalue = 'null';
                    break;
                case v.type.signature === JTYPES.Object.signature:
                    // Object doesn't really have anything worth seeing, so just treat it as unexpandable
                    objvalue = v.type.typename;
                    break;
                case v.type.signature === JTYPES.String.signature:
                    objvalue = JSON.stringify(v.string);
                    if (v.biglen) {
                        // since this is a big string - make it viewable on expand
                        varref = ++this._nextObjVarRef;
                        this._variableHandles[varref] = {varref:varref, bigstring:v};
                        objvalue = `String (length:${v.biglen})`;
                    }
                    else if (this._expandable_prims) {
                        // as a courtesy, allow strings to be expanded to see their length
                        varref = ++this._nextObjVarRef;
                        this._variableHandles[varref] = {varref:varref, signature:v.type.signature, primitive:true, value:v.string.length};
                    }
                    break;
                case JTYPES.isArray(v.type):
                    // non-null array type - if it's not zero-length add another variable reference so the user can expand
                    if (v.arraylen) {
                        varref = ++this._nextObjVarRef;
                        this._variableHandles[varref] = { varref:varref, arrvar:v, range:[0,v.arraylen] };
                    }
                    objvalue = v.type.typename.replace(/]$/, v.arraylen+']');   // insert len as the final array bound
                    break;
                case JTYPES.isObject(v.type):
                    // non-null object instance - add another variable reference so the user can expand
                    varref = ++this._nextObjVarRef;
                    this._variableHandles[varref] = {varref:varref, objvar:v};
                    objvalue = v.type.typename;
                    break;
                case v.type.signature === 'C': 
                    const cmap = {'\f':'f','\r':'r','\n':'n','\t':'t','\v':'v','\'':'\'','\\':'\\'}, cc = v.value.charCodeAt(0);
                    if (cmap[v.value]) {
                        objvalue = `'\\${cmap[v.value]}'`;
                    } else if (cc < 32) {
                        objvalue = cc ? `'\\u${('000'+cc.toString(16)).slice(-4)}'` : "'\\0'";
                    } else objvalue = `'${v.value}'`;
                    break;
                case v.type.signature === 'J':
                    // because JS cannot handle 64bit ints, we need a bit of extra work
                    var v64hex = v.value.replace(/[^0-9a-fA-F]/g,'');
                    objvalue = NumberBaseConverter.hexToDec(v64hex, true);
                    break;
                default:
                    // other primitives: int, boolean, etc
                    objvalue = v.value.toString();
                    break;
            }
            // as a courtesy, allow integer and character values to be expanded to show the value in alternate bases
            if (this._expandable_prims && /^[IJBSC]$/.test(v.type.signature)) {
                varref = ++this._nextObjVarRef;
                this._variableHandles[varref] = {varref:varref, signature:v.type.signature, primitive:true, value:v.value};
            }
            return {
                name: v.name,
                type: typename,
                value: objvalue,
                variablesReference: varref,
            }
        });

    }

	variablesRequest(response/*: DebugProtocol.VariablesResponse*/, args/*: DebugProtocol.VariablesArguments*/) {

        const return_mapped_vars = (vars, response) => {
            response.body = {
                variables: this._locals_to_variables(vars.filter(v => v.valid))
            };
            this.sendResponse(response);
        }

        var varinfo = this._variableHandles[args.variablesReference];
        if (!varinfo) {
            return_mapped_vars([], response);
        }
        else if (varinfo.cached) {
            return_mapped_vars(varinfo.cached, response);
        }
        else if (varinfo.objvar) {
            // object fields request
            this.dbgr.getsupertype(varinfo.objvar, {varinfo:varinfo, response:response})
                .then((supertype, x) => {
                    x.supertype = supertype;
                    return this.dbgr.getfieldvalues(x.varinfo.objvar, x);
                })
                .then((fields, x) => {
                    // ignore supertypes of Object
                    x.supertype && x.supertype.signature!=='Ljava/lang/Object;' && fields.unshift({
                        vtype:'super',
                        name:'super',
                        hasnullvalue:false,
                        type: x.supertype,
                        value: x.varinfo.objvar.value,
                        valid:true,
                    });
                    x.varinfo.cached = fields;
                    return_mapped_vars(fields, x.response);
                });
        }
        else if (varinfo.arrvar) {
            // array elements request
            var range = varinfo.range, count = range[1] - range[0];
            // should always have a +ve count, but just in case...
            if (count <= 0) return return_mapped_vars([], response);
            // add some hysteresis
            if (count > 110) {
                // create subranges in the sub-power of 10
                var subrangelen = Math.max(Math.pow(10, (Math.log10(count)|0)-1),100), variables = [];
                for (var i=range[0],varref,v; i < range[1]; i+= subrangelen) {
                    varref = ++this._nextObjVarRef;
                    v = this._variableHandles[varref] = { varref:varref, arrvar:varinfo.arrvar, range:[i, Math.min(i+subrangelen, range[1])] };
                    variables.push({name:`[${v.range[0]}..${v.range[1]-1}]`,type:'',value:'',variablesReference:varref});
                }
                response.body = {
                    variables: variables
                };
                this.sendResponse(response);
                return;
            }
            // get the elements for the specified range
            this.dbgr.getarrayvalues(varinfo.arrvar, range[0], count, response)
                .then((elements, response) => {
                    varinfo.cached = elements;
                    return_mapped_vars(elements, response);
                });
        }
        else if (varinfo.bigstring) {
            this.dbgr.getstringchars(varinfo.bigstring.value, response)
                .then((s,response) => {
                    return_mapped_vars([{name:'<value>',hasnullvalue:false,string:s,type:JTYPES.String,valid:true}], response);
                });
        }
        else if (varinfo.primitive) {
            // convert the primitive value into alternate formats
            var variables = [], bits = {J:64,I:32,S:16,B:8}[varinfo.signature];
            const pad = (u,base,len) => ('0000000000000000000000000000000'+u.toString(base)).slice(-len);
            switch(varinfo.signature) {
                case 'Ljava/lang/String;':
                    variables.push({name:'<length>',type:'',value:varinfo.value.toString(),variablesReference:0});
                    break;
                case 'C': 
                    variables.push({name:'<charCode>',type:'',value:varinfo.value.charCodeAt(0).toString(),variablesReference:0});
                    break;
                case 'J':
                    // because JS cannot handle 64bit ints, we need a bit of extra work
                    var v64hex = varinfo.value.replace(/[^0-9a-fA-F]/g,'');
                    const s4 = { hi:parseInt(v64hex.slice(0,8),16), lo:parseInt(v64hex.slice(-8),16) };
                    variables.push(
                        {name:'<binary>',type:'',value:pad(s4.hi,2,32)+pad(s4.lo,2,32),variablesReference:0}
                        ,{name:'<decimal>',type:'',value:NumberBaseConverter.hexToDec(v64hex,false),variablesReference:0}
                        ,{name:'<hex>',type:'',value:pad(s4.hi,16,8)+pad(s4.lo,16,8),variablesReference:0}
                    );
                    break;
                default:// integer/short/byte value
                    const u = varinfo.value >>> 0;
                    variables.push(
                        {name:'<binary>',type:'',value:pad(u,2,bits),variablesReference:0}
                        ,{name:'<decimal>',type:'',value:u.toString(10),variablesReference:0}
                        ,{name:'<hex>',type:'',value:pad(u,16,bits/4),variablesReference:0}
                    );
                    break;
            }
            response.body = {
                variables: variables
            };
            this.sendResponse(response);
        }
        else {
            // frame locals request
            this.dbgr.getlocals(varinfo.frame.threadid, varinfo.frame, response)
                .then((locals, response) => {
                    varinfo.cached = locals;
                    return_mapped_vars(locals, response);
                    if (this._locals_done) {
                        this._locals_done.resolveWith(this, [locals]);
                        this._locals_done = null;
                    };
                });
        }
	}

	continueRequest(response/*: DebugProtocol.ContinueResponse*/, args/*: DebugProtocol.ContinueArguments*/) {
        D('Continue');
        this._variableHandles = {};
        // sometimes, the device is so quick that a breakpoint is hit
        // before we've completed the resume promise chain.
        // so tell the client that we've resumed now and just send a StoppedEvent
        // if it ends up failing
        this._running = true;
        this._locals_done = $.Deferred();
        this.dbgr.resume()
            .then(() => {
                if (args.is_start)
                    this.LOG(`App started`);
            })
            .fail(() => {
                if (!response)
                    this.sendEvent(new StoppedEvent('Continue failed'));
                this.failRequest('Resume command failed', response);
                response = null;
            });
        response && this.sendResponse(response) && D('Sent continue response');
        response = null;
	}

    /**
     * Called by the debugger after a step operation has completed
     */
    onStep(e) {
        D('step hit: ' + JSON.stringify(e.stoppedlocation));
        this._running = false;
        this.sendEvent(new StoppedEvent("step", parseInt(e.stoppedlocation.threadid,16)));
    }

    /**
     * Called by the user to start a step operation
     */
    doStep(which, response, args) {
        D('step '+which);
        this._variableHandles = {};
        var threadid = ('000000000000000' + args.threadId.toString(16)).slice(-16);
        this.dbgr.step(which, threadid)
            .then(() => {
                this._running = true;
                this._locals_done = $.Deferred();
        		this.sendResponse(response);
            });
    }

	stepInRequest(response/*: DebugProtocol.NextResponse*/, args/*: DebugProtocol.StepInArguments*/) {
        this.doStep('in', response, args);
	}

	nextRequest(response/*: DebugProtocol.NextResponse*/, args/*: DebugProtocol.NextArguments*/) {
        this.doStep('over', response, args);
	}

	stepOutRequest(response/*: DebugProtocol.NextResponse*/, args/*: DebugProtocol.StepOutArguments*/) {
        this.doStep('out', response, args);
	}

    /**
     * Called by VSCode to perform watch, console and hover evaluations
     */
	evaluateRequest(response/*: DebugProtocol.EvaluateResponse*/, args/*: DebugProtocol.EvaluateArguments*/) {

        // Some notes to remember:
        // annoyingly, during stepping, the step can complete before the resume has called evaluateRequest on watches.
        //      The order can go: doStep(running=true),onStep(running=false),evaluateRequest(),evaluateRequest()
        // so we end up evaluating twice...
        // also annoyingly, this method is called before the locals in the current stack frame are evaluated
        // and even more annoyingly, Android (or JDWP) seems to get confused on the first request when we're retrieving multiple values, fields, etc
        // so we have to queue them or we end up with strange results

        if (this._running) {
            response.body = { result:'(running)', variablesReference:0 };
        	this.sendResponse(response);
            return;
        }
        this._evals_queue.push([response,args]);
        if (this._evals_queue.length > 1)
            return;
        if (this._locals_done) {
            // wait for the promise to be resolved (after the locals have been retrieved)
            this._locals_done.then(() => {
                // start the evaluations
                this.doNextEvaluateRequest();
            });
            return;
        }
        // we reach here if the program is paused, all the queued evaluations are done and a new evaluation is requested
        this.doNextEvaluateRequest();
    }

    sendResponseAndDoNext(response, value, varref) {
        response.body = { result:value, variablesReference:varref|0 };
        this.sendResponse(response);
        this._evals_queue.shift();
        this.doNextEvaluateRequest();
    }

    doNextEvaluateRequest() {
        if (!this._evals_queue.length) return;
        this.doEvaluateRequest.apply(this, this._evals_queue[0]);
    }

    doEvaluateRequest(response, args) {

        // just in case the user starts the app running again, before we've evaluated everything in the queue
        if (this._running) {
        	return this.sendResponseAndDoNext(response, '(running)');
        }

        var parse_array_or_fncall = function(e) {
            var arg, res = {arr:[], call:null};
            // pre-call array indexes
            while (e.expr[0] === '[') {
                e.expr = e.expr.slice(1).trim();
                if ((arg = parse_expression(e)) === null) return null;
                res.arr.push(arg);
                if (e.expr[0] !== ']') return null;
                e.expr = e.expr.slice(1).trim();
            }
            if (res.arr.length) return res;
            // method call
            if (e.expr[0] === '(') {
                res.call = []; e.expr = e.expr.slice(1).trim();
                if (e.expr[0] !== ')') {
                    for (;;) {
                        if ((arg = parse_expression(e)) === null) return null;
                        res.call.push(arg);
                        if (e.expr[0] === ')') break;
                        if (e.expr[0] !== ',') return null;
                        e.expr = e.expr.slice(1).trim();
                    }
                }
                e.expr = e.expr.slice(1).trim();
                // post-call array indexes
                while (e.expr[0] === '[') {
                    e.expr = e.expr.slice(1).trim();
                    if ((arg = parse_expression(e)) === null) return null;
                    res.arr.push(arg);
                    if (e.expr[0] !== ']') return null;
                    e.expr = e.expr.slice(1).trim();
                }
            }
            return res;
        }
        var parse_expression = function(e) {
            var root_term = e.expr.match(/^(?:(true(?![\w$]))|(false(?![\w$]))|(null(?![\w$]))|([a-zA-Z_$][a-zA-Z0-9_$]*)|(\d+(?:\.\d+)?)|('[^\\']')|('\\[frntv0]')|('\\u[0-9a-fA-F]{4}')|("[^"]*"))/);
            if (!root_term) return null;
            var res = {
                root_term: root_term[0],
                root_term_type: ['boolean','boolean','null','ident','number','char','echar','uchar','string'][[1,2,3,4,5,6,7,8,9].find(x => root_term[x])-1],
                array_or_fncall: null,
                members:[],
            }
            e.expr = e.expr.slice(res.root_term.length).trim();
            if ((res.array_or_fncall = parse_array_or_fncall(e)) === null) return null;
            // the root term is not allowed to be a method call
            if (res.array_or_fncall.call) return null;
            while (e.expr[0] === '.') {
                // member expression
                e.expr = e.expr.slice(1).trim();
                var m, member_name = e.expr.match(/^[a-zA-Z_$][a-zA-Z0-9_$]*/);
                if (!member_name) return null;
                res.members.push(m = {member:member_name[0], array_or_fncall:null})
                e.expr = e.expr.slice(m.member.length).trim();
                if ((m.array_or_fncall = parse_array_or_fncall(e)) === null) return null;
            }
            return res;
        }
        const descape_char = (c) => {
            if (c.length===2) {
                // backslash escape
                var x = {'f':'\f','r':'\r','n':'\n','t':'\t',v:'\v'}[c[1]];
                return x || (c[1]==='0'?String.fromCharCode(0):c[1]);
            }
            // unicode escape
            return String.fromCharCode(parseInt(c.slice(2,6),16));
        }
        var reject_evaluation = (msg) => $.Deferred().rejectWith(this, [new Error(msg)]);
        var evaluate_number = (n) => {
            const numtype = /\./.test(n) ? JTYPES.double : JTYPES.int;
            const iszero = /^0+(\.0*)?$/.test(n);
            return { vtype:'literal',name:'',hasnullvalue:iszero,type:numtype,value:n,valid:true };
        }
        var evaluate_expression = (expr) => {
            var q = $.Deferred(), local;
            switch(expr.root_term_type) {
                case 'boolean':
                    local = { vtype:'literal',name:'',hasnullvalue:false,type:JTYPES.boolean,value:expr.root_term,valid:true };
                    break;
                case 'null':
                    const nullvalue = '0000000000000000'; // null reference value
                    local = { vtype:'literal',name:'',hasnullvalue:true,type:JTYPES.null,value:nullvalue,valid:true };
                    break;
                case 'ident':
                    var v = this._variableHandles[args.frameId];
                    if (v && v.frame && v.cached)
                        local = v.cached.find(l => l.name === expr.root_term);
                    break;
                case 'number':
                    local = evaluate_number(expr.root_term);
                    break;
                case 'char':
                    local = expr.root_term[1]; // fall-through
                case 'echar':
                case 'uchar':
                    !local && (local = descape_char(expr.root_term.slice(1,-1))); // fall-through
                    local = { vtype:'literal',name:'',hasnullvalue:false,type:JTYPES.char,value:local,valid:true };
                    break;
                case 'string':
                    const raw = expr.root_term.slice(1,-1).replace(/\\u[0-9a-fA-F]{4}|\\./,descape_char);
                    // we must get the runtime to create string instances
                    q = this.dbgr.createstring(raw);
                    local = {valid:true};   // make sure we don't fail the evaluation
                    break;
            }
            if (!local || !local.valid) return reject_evaluation('not available');
            // we've got the root term variable - work out the rest
            q = expr.array_or_fncall.arr.reduce((q,index_expr) => {
                return q.then(function(index_expr,local) { return evaluate_array_element.call(this,index_expr,local) }.bind(this,index_expr));
            }, q);
            q = expr.members.reduce((q,m) => {
                return q.then(function(m,local) { return evaluate_member.call(this,m,local) }.bind(this,m));
            }, q);
            // if it's a string literal, we are already waiting for the runtime to create the string
            // - otherwise, start the evalaution...
            if (expr.root_term_type !== 'string')
                q.resolveWith(this,[local]);
            return q;
        }
        var evaluate_array_element = (index_expr, arr_local) => {
            if (arr_local.type.signature[0] !== '[') return reject_evaluation('TypeError: value is not an array');
            if (arr_local.hasnullvalue) return reject_evaluation('NullPointerException');
            return evaluate_expression(index_expr)
                .then(function(arr_local, idx_local) {
                    if (!JTYPES.isInteger(idx_local.type)) return reject_evaluation('TypeError: array index is not an integer value');
                    var idx = parseInt(idx_local.value,10);
                    if (idx < 0 || idx >= arr_local.arraylen) return reject_evaluation('BoundsError: array index out of bounds');
                    return this.dbgr.getarrayvalues(arr_local, idx, 1)
                }.bind(this,arr_local))
                .then(els => els[0])
        }
        var evaluate_methodcall = (m, obj_local) => {
            return reject_evaluation('Error: method calls are not supported');
        }
        var evaluate_member = (m, obj_local) => {
            if (!JTYPES.isReference(obj_local.type)) return reject_evaluation('TypeError: value is not a reference type');
            if (obj_local.hasnullvalue) return reject_evaluation('NullPointerException');
            if (m.array_or_fncall.call) return evaluate_methodcall(m, obj_local);
            // length is a 'fake' field of arrays, so special-case it
            if (JTYPES.isArray(obj_local.type) && m.member==='length') 
                return evaluate_number(obj_local.arraylen);
            return this.dbgr.getfieldvalues(obj_local, m)
                .then((fields,m) => {
                    var field = fields.find(f => f.name === m.member);
                    if (!field) return reject_evaluation('no such field: '+m.member);
                    if (m.array_or_fncall.arr.length) {
                        var q = $.Deferred();
                        m.array_or_fncall.arr.reduce((q,index_expr) => {
                            return q.then(function(index_expr,local) { return evaluate_array_element(index_expr,local) }.bind(this,index_expr));
                        }, q);
                        return q.resolveWith(this, [field]);
                    }
                    return field;
                })
        }
        D('evaluate: ' + args.expression);
        var e = { expr:args.expression };
        var parsed_expression = parse_expression(e);
        // if there's anything left, it's an error
        if (parsed_expression && !e.expr) {
            // the expression is well-formed - start the (asynchronous) evaluation
            evaluate_expression(parsed_expression)
                .then(function(response,local) {
                    var v = this._locals_to_variables([local])[0];
                    this.sendResponseAndDoNext(response, v.value, v.variablesReference);
                }.bind(this,response))
                .fail(function(response,reason) {
                    this.sendResponseAndDoNext(response, reason.message);
                }.bind(this,response))
            return;
        }

        // the expression is not well-formed
        this.sendResponseAndDoNext(response, 'not available');
	}

}


DebugSession.run(AndroidDebugSession);