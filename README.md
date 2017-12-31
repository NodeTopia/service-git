# service-git
Starts a git server on `nconf.get('git:server:port')`
The process from `git push` to application deploy takes place in the service.

## Run
RUN NOTES:
- This process can be run in the system.
- Can be run as a standalone.
```
node git.js /path/to/config/file.json
```

# STEPS
Steps that are taken by this service
## Step 1
Authenticates user and determines write permissions on repo in question
## Step 2
Ceates tarball of git repo and uploads it to s3 storage
## Step 3
Reads Procfile
## Step 4
Calls the `build` service
## Step 5
Calls `fleet.deploy`

# EVENTS
Events this service emits.
## git.start
Data is the `gitrepo` Object
## git.end
Data is the `gitrepo` Object
## git.error
Errors that might come up in the git process. 
This is ontop of the errors that are sent back to the caller.

# TODO
-	Add some kind of gitweb