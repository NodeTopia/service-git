var Git = require('giting');
var http = require('http');
var path = require('path');
var fs = require('fs');
//var gitweb = require('gitweb');
var Minio = require('minio');
var tar = require('tar-fs');
var procfile = require('procfile');

var nconf = require('nconf');
var ms = require('ms');
var colors = require('colors');

var errors = require('nodetopia-lib/errors');
var helpers = require('nodetopia-lib/helpers');
var authenticate = require('nodetopia-lib/authenticate');

var mongoose = require('nodetopia-model');

nconf.file({
	file : path.resolve(process.argv[2])
});
nconf.env();

var logo = fs.readFileSync(path.join(__dirname, 'logo.txt'), 'utf8').split('\n').map(function(str) {
	return str.red;
}).join('\n');

/*
 *Setup mongodb store
 */
mongoose.start(nconf.get('mongodb'));

var minioClient = new Minio(nconf.get('s3'));

var User = mongoose.User;
var Repo = mongoose.Repo;
var Commit = mongoose.Commit;
var Build = mongoose.Build;
var Formation = mongoose.Formation;
var Domain = mongoose.Domain;

/*
 *Setup Kue jobs
 */
var kue = require('nodetopia-kue');
var jobs = kue.jobs;

var git = new Git({
	auth : function auth(username, password, callback) {
		User.getAuthenticated(username, password, function(err, user, reason) {
			if (err) {
				kue.events.emit('git.error', err);
				return callback(errors.authenticated(err));
			}
			if (user) {
				return callback(null, user);
			}
			callback(401);
		});
	},
	autoCreate : nconf.get('git:autoCreate'),
	dir : nconf.get('git:dir')
});

var server = http.createServer(function(req, res) {

	req.pause();
	git.handle(req, res, function() {
		res.statusCode = 403;
		return res.end('403 Forbidden');
	});
});

server.setTimeout(nconf.get('get:timeout'), function() {
	errors.git(new Error('Socket time out'));
});

server.listen(nconf.get('git:server:port'), nconf.get('git:server:host'));
/**
 *
 *
 *
 */

function authRepo(organization, name, credentials, cb) {
	var username = credentials.username;
	var userId = credentials._id;

	mongoose.Organization.findOne({
		name : organization
	}, function(err, organization) {
		if (err) {
			kue.events.emit('git.error', err);
			cb(new Error('403 Forbidden'));
			return errors.mongoose(err);
		}

		mongoose.App.findOne({
			name : name,
			organization : organization._id
		}, function(err, app) {
			if (err) {
				kue.events.emit('git.error', err);
				cb(new Error('403 Forbidden'));
				return errors.mongoose(err);
			}

			if (!app) {

				kue.events.emit('git.error', new Error('Request was rejected, no repo was found for "' + name + '"'));

				return cb(new Error('403 Forbidden'));
			}

			if (!authenticate.role(app.organization, credentials, 4)) {

				return cb(new Error('403 Forbidden'));
			}

			cb();
		});
	});
}

git.perm(function(gitrepo) {
	var organization = gitrepo.organization;
	var name = gitrepo.name;
	authRepo(organization, name, gitrepo.credentials, function(err) {
		if (err) {
			kue.events.emit('git.error', err);
			return gitrepo.reject(err);

		}
		gitrepo.accept();
	});
});

git.on('sideband', function(gitrepo) {

	kue.events.emit('git.start', gitrepo);
	var sideband = gitrepo.sideband;
	sideband.write('\n\n');
	sideband.write('Raft is in beta status. \nPlease keep this in mind when you use our service\n');
	sideband.write('Builds can take upto 10 minutes and is limited to ' + (nconf.get('build:ttl') / 1000 / 60) + ' minutes\n');
	sideband.write('\n');
	sideband.write(logo);
	sideband.write('\n\n');

	function onError(err) {
		kue.events.emit('git.error', err);
		return sideband.end(JSON.stringify(errors.git(err), null, 2).red + '\n');
	}


	helpers.docs({
		name : gitrepo.name,
		organization : gitrepo.organization
	}, function(err, docs) {
		docs.gitrepo = gitrepo;
		tarball(docs, gitrepo, function(err, tarPath) {
			if (err) {
				kue.events.emit('git.error', err);
				return onError(err);
			}
			docs.tarPath = tarPath;
			readProcfile(docs, gitrepo, function(err, proc) {
				if (err) {
					kue.events.emit('git.error', err);
					return onError(err);
				}

				docs.proc = proc;

				build(docs, function(err, docs) {
					if (err) {
						kue.events.emit('git.error', err);
						return onError(err);
					}
					deploy(docs, function(err) {
						if (err) {
							kue.events.emit('git.error', err);
							return onError(err);
						}

						docs.domains.forEach(function(domain) {
							sideband.write('       http://' + domain.url + '/ deployed to Raft\n');
						});

						kue.events.emit('git.end', gitrepo);
						sideband.end('');

					});
				});
			});
		});

	});
});
function readProcfile(docs, gitrepo, cb) {
	var procFilePath = path.join(git.checkoutDir(docs.app.organization.name, docs.app.name), 'Procfile');
	fs.exists(procFilePath, function(exists) {

		if (!exists) {
			return cb(new Error('Procfile missing from root of project'));
		}

		fs.readFile(procFilePath, function(err, data) {
			if (err) {
				return cb(err);
			}
			try {
				var proc = procfile.parse(data.toString());
			} catch(err) {
				return cb(err);
			}
			cb(null, proc);
		});
	});
}

function tarball(docs, gitrepo, cb) {
	var tarStream = tar.pack(git.checkoutDir(docs.app.organization.name, docs.app.name), {
		ignore : function(name) {
			return name.indexOf('.git') != -1;
		}
	});
	
	var tarPath = docs.app.organization.name + '/' + docs.app.name + '/application/' + docs.tag + '.tar';

	minioClient.putObject('tar', tarPath, tarStream, 0, 'application/x-tar', function(err) {
		if (err) {
			return cb(err);
		}
		cb(null, tarPath);
	});
}

function deploy(docs, cb) {

	var sideband = docs.gitrepo.sideband;

	sideband.write('-----> ' + "Deploying application..." + "\n");
	sideband.write('       ' + "Please wait..." + "\n");

	var now = Date.now();

	jobs.create('fleet.app.deploy', {
		organization : docs.app.organization.name,
		build : docs.build._id,
		name : docs.app.name
	}).on('complete', function(result) {

		sideband.write('-----> Deploy completed\n');
		sideband.write('       ' + "Took " + ms((Date.now() - now), {
			long : true
		}) + ' to deploy' + "\n");
		cb();
		
	}).on('failed', function(err) {
		
		sideband.write('-----> Deploy failed\n');
		sideband.write('       ' + err + "\n");
		sideband.write('       ' + "Took " + ms((Date.now() - now), {
			long : true
		}) + ' to deploy' + "\n");

		cb(errors.git(err));
		
	}).on('log', function(line) {
		
		if (line.indexOf('Error:') == 0) {
			sideband.write('\n\n' + line.red + '\n\n');
		} else
			sideband.write(line + '\n');
			
	}).ttl(nconf.get('deploy:ttl')).save();
}

function build(docs, cb) {
	
	var sideband = docs.gitrepo.sideband;

	var commit = new Commit({
		user : docs.gitrepo.credentials._id,
		repo : docs.repo._id,
		name : docs.app.name,
		organization : docs.app.organization._id,
		action : docs.gitrepo.action,
		commit : docs.gitrepo.commit,
		branch : docs.gitrepo.branch,
		tar : docs.tarPath
	});

	commit.save(function(err) {

		if (err) {
			kue.events.emit('git.error', err);
			return cb(errors.mongoose(err));
		}

		docs.commit = commit;

		sideband.write('-----> Starting build process\n');

		var timmer = setInterval(function() {
			sideband.write('');
		}, 5000);

		var now = Date.now();

		var job = jobs.create('build', {
			name : docs.app.name,
			organization : docs.app.organization.name,
			commit : docs.commit._id,
			proc : docs.proc
		}).on('complete', function(build) {
			
			clearInterval(timmer);
			sideband.write('-----> ' + "Build completed...".green + "\n");
			sideband.write('       ' + "Took " + ms((Date.now() - now), {
				long : true
			}) + ' to build' + "\n");

			docs.build = build;
			cb(null, docs);
			
		}).on('failed', function(err) {
			
			clearInterval(timmer);
			sideband.write('-----> Build failed\n');
			sideband.write('       ' + err + "\n");
			sideband.write('       ' + "Took " + ms((Date.now() - now), {
				long : true
			}) + ' to deploy' + "\n");
			cb(errors.git(err));
			
		}).on('log', function(line) {
			
			if (line.indexOf('Error:') == 0) {
				sideband.write('\n\n' + line.red + '\n\n');
			} else
				sideband.write(line + '\n');
		}).ttl(nconf.get('build:ttl')).save();
		
	});
}