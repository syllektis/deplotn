
import * as fs from "fs";
import * as process from "process";
import * as core from "@actions/core";
import { spawn } from "child_process";
import * as github from "@actions/github";
import { Client, ConnectConfig, ClientChannel } from 'ssh2';

let verbose: boolean = false;
let __TEST_OBJECT: any = null;
let __ENVIRONMENT_VARS: { [key: string]: string; } = {};

class MicroQueue<T> {

    private elements: T[];

    constructor(elements: T[]) {
        this.elements = elements;
    }

    size() {
        return this.elements.length;
    }

    dequeue(fn?: (entry: T) => void, suffix?: T) {
        if (this.elements.length === 0) {
            return undefined;
        }
        let element = this.elements.shift();
        if (element) {
            if (suffix) element += suffix as any;
            if (fn) fn(element);
        }
        return element;
    }
}

async function main(argc: number, argv: string[]) {
    if (argv.includes("--test")) {
        setupTest(argc, argv);
    }
    verbose = getInput("verbose", "boolean", false);
    if (process.env.REPO_VARS) {
        let parsed = JSON.parse(process.env.REPO_VARS);
        Object.keys(parsed).forEach((k) => {
            process.env[k] = parsed[k];
        })
    }
    await prepareEnvironmentVars();
    await createEnvFile();
    await buildAndPushDockerImage(async () => {
        await executeSshCommands();
    });
}

async function prepareEnvironmentVars() {
    const environment = getInput("environment", "string", "main");
    const environmentOutput = getInput("environment-output", "boolean");
    const environmentVarsRaw = getInput("environment-vars", "array") as string[];
    const environmentCasing = (getInput("environment-casing") ?? "").toUpperCase();
    const environmentVarsReadPrefixRaw = getInput("environment-vars-read-prefix", "string", "") ?? "";
    const environmentVarsWritePrefixRaw = getInput("environment-vars-write-prefix", "string", "") ?? "";
    const environmentVarsReadPrefix = executeInstruction(expandVariables(environmentVarsReadPrefixRaw), environmentCasing);
    const environmentVarsWritePrefix = executeInstruction(expandVariables(environmentVarsWritePrefixRaw), environmentCasing);
    const environmentVars = environmentVarsRaw?.reduce((acc: any, key: string) => {
        let instruction = "";
        if (key.includes("|")) {
            const [_key, _instruction] = key.split("|");
            key = _key;
            instruction = _instruction;
        }
        key = expandVariables(key);
        acc[key] = executeInstruction(process.env[environmentVarsReadPrefix + key] ?? "", instruction)?.replaceAll("\r", "");
        return acc;
    }, {});
    if (verbose) {
        const environmentVarsOutputs = Object.keys(environmentVars).reduce((acc: any, k) => {
            acc[environmentVarsWritePrefix + k] = environmentVars[k];
            return acc;
        }, {});
        print("log", "ENV=", environment);
        print("log", "ENV-CASING=", environmentCasing);
        print("log", "ENV-VARS-READ-PREFIX - (PRE)=", environmentVarsReadPrefixRaw);
        print("log", "ENV-VARS-READ-PREFIX - (POST)=", environmentVarsReadPrefix);
        print("log", "ENV-VARS-WRITE-PREFIX - (PRE)=", environmentVarsWritePrefixRaw);
        print("log", "ENV-VARS-WRITE-PREFIX - (POST)=", environmentVarsWritePrefix);
        print("log", "ENV-VARS= (PRE)", environmentVarsRaw);
        print("log", "ENV-VARS= (POST)", environmentVars);
        print("log", "ENV-VARS-OUTPUT=", environmentVarsOutputs);
    }
    Object.keys(environmentVars).forEach((key) => {
        if (environmentOutput) core.setOutput(environmentVarsWritePrefix + key, environmentVars[key]);
        __ENVIRONMENT_VARS[environmentVarsWritePrefix + key] = environmentVars[key];
    });
    core.setOutput("env-setup-completed", true);
}

async function createEnvFile() {
    const envCreation = getInput("env-creation", "boolean", false);
    if (!envCreation) {
        return;
    }


    print("log!", "Creating environment variable file", "\n");
    const environmentCasing = (getInput("environment-casing") ?? "").toUpperCase();
    const environmentVarsWritePrefixRaw = getInput("environment-vars-write-prefix") ?? "";
    const environmentVarsWritePrefix = executeInstruction(expandVariables(environmentVarsWritePrefixRaw), environmentCasing);
    const environmentVars = Object.entries(__ENVIRONMENT_VARS).reduce((acc, [key, value]) => {
        acc[key.replace(environmentVarsWritePrefix, "")] = value;
        return acc;
    }, {} as { [k: string]: string; });
    const envVariablesKeys = getInput("environment-vars", "array") as string[];
    const envFile = getInput("env-file-path", "string", environmentVars["ENV_FILE_PATH"] ?? process.env.ENV_FILE_PATH ?? ".env");
    const envRawFileContent = getInput("env-file-content", "string", environmentVars["ENV_FILE_CONTENT"] ?? process.env.ENV_FILE_CONTENT ?? "");

    let envFileContent = envRawFileContent;
    for (const envVariablesKey of envVariablesKeys) {
        const value = environmentVars[envVariablesKey] ?? process.env[envVariablesKey];
        if (value) {
            envFileContent += value + "\n";
        }
    }

    print("log", "Environment variables map to read from:\n", JSON.stringify(environmentVars, null, 2), "");
    print("log!", "Output File:", envFile, "\n");
    print("log", "Writing the env content:\n", envFileContent);
    print("log!", "Successfully created environment variable file", "\n");
    fs.writeFileSync(envFile, envFileContent);
}

async function buildAndPushDockerImage(onComplete: () => void) {
    if (!getInput("dockerize", "boolean")) {
        onComplete();
        return;
    }
    const environment = getInput("environment", "string", "main");
    const dockerfile = getInput("dockerfile", "string", "Dockerfile");
    const dockerImageTag = getInput("docker-image-tag", "string", "");
    const appName = getInput("app-name", "string", process.env.APP_NAME ?? "");
    const dockerImageNamespace = getInput("docker-image-namespace", "string", "");
    const dockerProjectEnvPath = getInput("docker-project-env-path", "string", "");
    const environmentCasing = (getInput("environment-casing") ?? "").toUpperCase();
    const environmentVarsRaw = getInput("docker-write-env-vars", "array") as string[];
    const envIsNamespace = getInput("environment-is-image-namespace", "boolean", false);
    const environmentVarsReadPrefixRaw = getInput("environment-vars-read-prefix") ?? "";
    const dockerRegistryHost = getInput("docker-registry-host", "string", process.env.REGISTRY_HOST ?? "");
    const dockerRegistryUsername = getInput("docker-registry-username", "string", process.env.REGISTRY_USERNAME ?? "");
    const dockerRegistryPassword = getInput("docker-registry-password", "string", process.env.REGISTRY_PASSWORD ?? "");
    const environmentVarsReadPrefix = executeInstruction(expandVariables(environmentVarsReadPrefixRaw), environmentCasing);
    const environmentVars = environmentVarsRaw.reduce((acc: any, key: string) => {
        let instruction = "";
        if (key.includes("|")) {
            const [_key, _instruction] = key.split("|");
            key = _key;
            instruction = _instruction;
        }
        key = expandVariables(key);
        if (key in __ENVIRONMENT_VARS) {
            acc[key] = executeInstruction(__ENVIRONMENT_VARS[key], instruction)?.replaceAll("\r", "");
        } else {
            acc[key] = process.env[environmentVarsReadPrefix + key]?.replaceAll("\r", "");
        }
        return acc;
    }, {});

    print("log", ".env Environment variables", environmentVars);

    if (Object.keys(environmentVars).length && dockerProjectEnvPath) {
        Object.keys(environmentVars).forEach((k) => {
            fs.writeFileSync(dockerProjectEnvPath, environmentVars[k]);
        });
    }
    print("log", `Preparing to build the image...`);
    const dockerShellProcess = spawn('sh');
    dockerShellProcess.stdout.on('data', (data) => {
        print("log!", `${data}`);
    });
    dockerShellProcess.stderr.on('data', (data) => {
        print("error", `${data}`);
    });
    dockerShellProcess.on('close', (code) => {
        if (code === 0) {
            onComplete();
            return;
        }
        print("log", `Docker:Shell:: closed with code - ${code}`);
        core.setFailed(`${code}`);
    });
    const imageTag = dockerImageTag ? (":" + dockerImageTag) : "";
    const imageNamespace = dockerImageNamespace ? (dockerImageNamespace + "/") : (envIsNamespace && environment ? (environment + "/") : "");
    dockerShellProcess.stdin.write(`echo '${dockerRegistryPassword}' | docker login -u ${dockerRegistryUsername} --password-stdin ${dockerRegistryHost};`);
    dockerShellProcess.stdin.write(`docker buildx build -f ${dockerfile} --platform=linux/amd64 -t ${appName} .;`);
    dockerShellProcess.stdin.write(`docker tag ${appName} ${dockerRegistryHost}/${imageNamespace}${appName}${imageTag};`);
    dockerShellProcess.stdin.write(`docker push ${dockerRegistryHost}/${imageNamespace}${appName}${imageTag};`);
    dockerShellProcess.stdin.end();
}

async function executeSshCommands() {
    if (!getInput("ssh-execution", "boolean", true)) {
        return;
    }
    const sshRuntimeMinutes = getInput("ssh-runtime-minutes", "number", 10);
    const environmentCasing = (getInput("environment-casing") ?? "").toUpperCase();
    const environmentVarsRaw = getInput("ssh-expose-vars", "array", []) as string[];
    const environmentVarsReadPrefixRaw = getInput("environment-vars-read-prefix") ?? "";
    const dockerEnvironmentVarsRaw = getInput("docker-app-env-vars", "array", []) as string[];
    const environmentVarsReadPrefix = executeInstruction(expandVariables(environmentVarsReadPrefixRaw), environmentCasing);
    const environmentVars: { [key: string]: string; } = ["SSH_HOST", "SSH_PORT", "SSH_USERNAME", "SSH_PASSWORD", "SSH_PRIVATEKEY", "SSH_CONNECTION"].concat(...environmentVarsRaw).concat(...dockerEnvironmentVarsRaw).reduce((acc: any, key: string) => {
        let instruction = "";
        if (key.includes("|")) {
            const [_key, _instruction] = key.split("|");
            key = _key;
            instruction = _instruction;
        }
        key = expandVariables(key);
        if (key in __ENVIRONMENT_VARS) {
            acc[key] = executeInstruction(__ENVIRONMENT_VARS[key], instruction);
        } else {
            acc[key] = process.env[environmentVarsReadPrefix + key];
        }
        return acc;
    }, {});
    const environmentVarsSshCommands: string[] = [];
    for (const environmentVar of environmentVarsRaw) {
        const value = (environmentVars[environmentVar] ?? process.env[environmentVar] ?? "");
        if (value.includes("=") && value.includes("\n")) {
            environmentVarsSshCommands.push(`export ${environmentVar}='` + value.replaceAll("\n", " ") + `'`);
            const environmentVarParts = value.split("\n");
            for (const environmentVarPart of environmentVarParts) {
                environmentVarsSshCommands.push(`export ${environmentVarPart.replaceAll("\r", "")}`);
            }
        } else {
            environmentVarsSshCommands.push(`export ${environmentVar}=` + value);
        }
    }

    let sshConnectionUsername, sshConnectionPassword, sshConnectionHost, sshConnectionPort;
    const sshConnection = getInput("ssh-connection", "string", environmentVars["SSH_CONNECTION"] ?? process.env.SSH_CONNECTION ?? "") as string;

    if (sshConnection) {
        const [sshAccess, sshDomain] = sshConnection.split("@");
        const [sshHost, ...sshPort] = sshDomain.split(":");
        const [sshUsername, ...sshPassword] = sshAccess.split(":");
        sshConnectionHost = sshHost;
        sshConnectionUsername = sshUsername;
        sshConnectionPort = (sshPort ?? []).join("");
        sshConnectionPassword = (sshPassword ?? []).join("");
    }

    const dokkuDeploy = getInput("dokku-deploy", "boolean", false);
    const dockerDeploy = getInput("docker-deploy", "boolean", false);
    const apache2Configure = getInput("apache2-configure", "boolean", false);
    const sshPostCommands = getInput("ssh-post-commands", "array", []) as string[];
    const sshHost = getInput("ssh-host", "string", environmentVars["SSH_HOST"] ?? process.env.SSH_HOST ?? sshConnectionHost ?? "");
    const sshPort = getInput("ssh-port", "string", environmentVars["SSH_PORT"] ?? process.env.SSH_PORT ?? sshConnectionPort ?? "");
    const sshPassphrase = getInput("ssh-passphrase", "string", environmentVars["SSH_PASSPHRASE"] ?? process.env.SSH_PASSPHRASE ?? "");
    const sshPrivateKey = getInput("ssh-privatekey", "string", environmentVars["SSH_PRIVATEKEY"] ?? process.env.SSH_PRIVATEKEY ?? "");
    const sshCommands = environmentVarsSshCommands.concat((getInput("ssh-commands", "array", []) as string[]).map((c) => `${c}[::]?`));
    const sshUsername = getInput("ssh-username", "string", environmentVars["SSH_USERNAME"] ?? process.env.SSH_USERNAME ?? sshConnectionUsername ?? "");
    const sshPassword = getInput("ssh-password", "string", environmentVars["SSH_PASSWORD"] ?? process.env.SSH_PASSWORD ?? sshConnectionPassword ?? "");

    if (!sshHost) {
        print("error", `ssh host not configured`);
        core.setFailed(`The ssh host is not configured`);
        return;
    }
    const port = getInput("port", "string", environmentVars["PORT"] ?? process.env.PORT ?? "");
    const appName = getInput("app-name", "string", environmentVars["APP_NAME"] ?? process.env.APP_NAME ?? "");
    const baseDomain = getInput("base-domain", "string", environmentVars["BASE_DOMAIN"] ?? process.env.BASE_DOMAIN ?? "");
    const environment = getInput("environment", "string", environmentVars["ENVIRONMENT"] ?? process.env.ENVIRONMENT ?? "");
    const containerPort = getInput("container-port", "string", environmentVars["CONTAINER_PORT"] ?? process.env.CONTAINER_PORT ?? port);
    print("log", "SSH Variables:", "Host=" + sshHost, "Port=" + sshPort, "Username=" + sshUsername, "Password=" + (sshPassword ?? "*")[0] + "*******");
    let appPublicPortRaw = getInput("app-public-port", "any", environmentVars["APP_PUBLIC_PORT"] ?? process.env.APP_PUBLIC_PORT ?? containerPort ?? port);

    // RESOLVE PORTS
    let appPublicPort;
    let commonAppPublicPort;
    let portParts = appPublicPortRaw.split(__TEST_OBJECT ? "\\n" : '\n');
    for (const portPart of portParts) {
        const portPartParts = portPart.split("|");
        if (portPartParts.length < 2) {
            commonAppPublicPort = portPartParts[0];
            continue;
        }
        if (environment === portPartParts[1]) {
            appPublicPort = portPartParts[0];
            break;
        }
    }
    if (!appPublicPort) appPublicPort = commonAppPublicPort ?? appPublicPortRaw;

    // DOKKU
    if (dokkuDeploy) {
        const dokkuSetupSsl = getInput("dokku-setup-ssl", "boolean", false);
        const dokkuDomains = (getInput("dokku-domains", "array", []) as string[]);
        const dokkuEnvironmentVars = getInput("dokku-environment-vars", "array", []);
        const dokkuAddEnvToDomain = getInput("dokku-add-env-to-domain", "boolean", true);
        const envIsNamespace = getInput("environment-is-image-namespace", "boolean", false);
        const registryHost = getInput("registry-host", "string", environmentVars["REGISTRY_HOST"] ?? process.env.REGISTRY_HOST ?? "");
        const dokkuAppName = getInput("dokku-app-name", "string", environmentVars["DOKKU_APP_NAME"] ?? process.env.DOKKU_APP_NAME ?? appName);
        const dockerImageTag = getInput("docker-image-tag", "string", environmentVars["DOCKER_IMAGE_TAG"] ?? process.env.DOCKER_IMAGE_TAG ?? "");
        const dokkuBaseDomain = getInput("dokku-base-domain", "string", environmentVars["DOKKU_BASE_DOMAIN"] ?? process.env.DOKKU_BASE_DOMAIN ?? baseDomain);
        const dokkuEnvironment = getInput("dokku-environment", "string", environmentVars["DOKKU_ENVIRONMENT"] ?? process.env.DOKKU_ENVIRONMENT ?? environment);
        const dokkuRegistryHost = getInput("dokku-registry-host", "string", environmentVars["DOKKU_REGISTRY_HOST"] ?? process.env.DOKKU_REGISTRY_HOST ?? registryHost);
        const dockerImageNamespace = getInput("docker-image-namespace", "string", environmentVars["DOCKER_IMAGE_NAMESPACE"] ?? process.env.DOCKER_IMAGE_NAMESPACE ?? "");
        const dokkuContainerPort = getInput("dokku-container-port", "string", environmentVars["DOKKU_CONTAINER_PORT"] ?? process.env.DOKKU_CONTAINER_PORT ?? containerPort ?? port);
        sshCommands.push(`dokku apps:create ${dokkuAppName}`);
        if ("DOKKU_CONFIGS" in environmentVars) {
            sshCommands.push(`dokku config:set ${dokkuAppName} ${environmentVars["DOKKU_CONFIGS"].replaceAll("\n", " ")}`);
        }
        if (dokkuEnvironmentVars?.length) {
            sshCommands.push(`dokku config:set ${dokkuAppName} ${dokkuEnvironmentVars.join(" ")}`);
        }
        if (dokkuBaseDomain) {
            sshCommands.push(`dokku domains:add ${dokkuAppName} ${dokkuAppName}.${dokkuAddEnvToDomain && dokkuEnvironment ? (dokkuEnvironment + ".") : ""}${dokkuBaseDomain}`);
        }
        for (const dokkuDomain of dokkuDomains) {
            const parts = dokkuDomain.split("|");
            const domain = parts[0];
            if (parts.length > 1) {
                if (environment !== parts[1]) continue;
            }
            sshCommands.push(`dokku domains:add ${dokkuAppName} ${domain}`);
        }
        const imageTag = dockerImageTag ? (":" + dockerImageTag) : "";
        const imageNamespace = dockerImageNamespace ? (dockerImageNamespace + "/") : (envIsNamespace && dokkuEnvironment ? (dokkuEnvironment + "/") : "");
        sshCommands.push(`dokku git:from-image ${dokkuAppName} ${dokkuRegistryHost}/${imageNamespace}${dokkuAppName}${imageTag} --force`);
        if (dokkuContainerPort) {
            sshCommands.push(`dokku ports:add ${dokkuAppName} http:${appPublicPort}:${dokkuContainerPort}`);
        }
        if (dokkuSetupSsl) {
            sshCommands.push(`$(dokku letsencrypt:active ${dokkuAppName}) || dokku letsencrypt:enable ${dokkuAppName}`);
        }
        sshCommands.push(`dokku ps:rebuild ${dokkuAppName}`);
    }

    // DOCKER
    let dockerAppName = appName;
    if (dockerDeploy) {
        dockerAppName = getInput("docker-app-name", "string", dockerAppName);
        const dockerImageNoCache = getInput("docker-image-nocache", "boolean", true);
        const dockerAppHealthCheck = getInput("docker-app-health-check", "boolean", true);
        const dockerRegistries = (getInput("docker-registries", "array", []) as string[]);
        const dockerAppHealthUrls = (getInput("docker-app-health-urls", "array", []) as string[]);
        const dockerAppRunArgs = getInput("docker-app-run-args", "string", environmentVars["DOCKER_APP_RUN_ARGS"] ?? process.env.DOCKER_APP_RUN_ARGS ?? "");
        const dockerAppPrintLog = getInput("docker-app-print-log", "number", environmentVars["DOCKER_APP_PRINT_LOG"] ?? process.env.DOCKER_APP_PRINT_LOG ?? 100);
        const dockerImageLocation = getInput("docker-image-location", "string", environmentVars["DOCKER_IMAGE_LOCATION"] ?? process.env.DOCKER_IMAGE_LOCATION ?? "");
        const dockerAppHealthWaitTime = getInput("docker-app-health-wait-time", "number", environmentVars["DOCKER_APP_HEALTH_WAIT_TIME"] ?? process.env.DOCKER_APP_HEALTH_WAIT_TIME ?? 5);
        const dockerAppHealthMaxCheck = getInput("docker-app-health-max-check", "number", environmentVars["DOCKER_APP_HEALTH_MAX_CHECK"] ?? process.env.DOCKER_APP_HEALTH_MAX_CHECK ?? 12);
        const dockerAppProcessWaitTime = getInput("docker-app-process-wait-time", "number", environmentVars["DOCKER_APP_PROCESS_WAIT_TIME"] ?? process.env.DOCKER_APP_PROCESS_WAIT_TIME ?? 10);

        for (const dockerRegistry of dockerRegistries) {
            const parts = dockerRegistry.split("|");
            const registry = parts[0];
            if (parts.length > 1) {
                if (environment !== parts[1]) continue;
            }
            const registryParts = registry.split("@");
            const domain = registryParts[registryParts.length - 1];
            const access = registryParts.slice(0, registryParts.length - 1);
            const [username, ...password] = access.join("@").split(":");
            sshCommands.push(`sudo echo "${password.join("")}" | docker login ${domain} -u ${username} --password-stdin`);
        }

        if (dockerImageNoCache) {
            sshCommands.push(`sudo docker rmi ${dockerImageLocation}[::]?`);
        }
        if (dockerImageLocation) {
            sshCommands.push(`sudo docker pull ${dockerImageLocation}`);
        }
        let dockerAppEnvVar = "";
        for (const dockerEnvironmentVar of dockerEnvironmentVarsRaw) {
            const value = (environmentVars[dockerEnvironmentVar] ?? process.env[dockerEnvironmentVar] ?? "");
            if (value.includes("=") && value.includes("\n")) {
                const dockerEnvironmentVarParts = value.split("\n");
                for (const dockerEnvironmentVarPart of dockerEnvironmentVarParts) {
                    dockerAppEnvVar += ` -e ${dockerEnvironmentVarPart.replaceAll("\r", "")}`;
                }
            } else {
                dockerAppEnvVar += ` -e ${dockerEnvironmentVar}=${value}`;
            }
        }
        const performDockerAppHealthCheck = dockerAppHealthCheck || !!dockerAppHealthUrls.length;
        const actualDockerAppStartCommand = `sudo docker run -d ${dockerAppEnvVar} --name ${dockerAppName} ${dockerAppRunArgs} -p ${appPublicPort}:${containerPort} ${dockerImageLocation}`;
        if (performDockerAppHealthCheck) {
            const dockerDeploymentPort = getRandomElement(generateWithinRange(60000, 65530, getRandomInt(1, 4)));
            const dockerDeploymentAppName = (dockerAppHealthCheck ? `${dockerAppName}_deploying` : dockerAppName);
            sshCommands.push(`sudo docker rm -f ${dockerDeploymentAppName}[::]?`);
            sshCommands.push(`sudo docker run -d ${dockerAppEnvVar} --name ${dockerDeploymentAppName} ${dockerAppRunArgs} -p ${dockerDeploymentPort}:${containerPort} ${dockerImageLocation}`);

            const localDockerAppUrl = `http://127.0.0.1:${dockerDeploymentPort}`;
            if (!dockerAppHealthUrls.length && dockerAppHealthCheck) {
                dockerAppHealthUrls.push(localDockerAppUrl);
            }
            sshCommands.push(`echo Checking if app has been successfully deployed...`);
            for (let dockerAppHealthUrl of dockerAppHealthUrls) {
                if (dockerAppHealthUrl.startsWith("/")) dockerAppHealthUrl = localDockerAppUrl + dockerAppHealthUrl;
                sshCommands.push(`
                    URL="${dockerAppHealthUrl}"; 
                    __DEPLOTN_APP_DEPLOYED__=1; 
                    for i in {1..${dockerAppHealthMaxCheck}}; 
                        do curl -sf "$URL" > /dev/null && __DEPLOTN_APP_DEPLOYED__=0 && break || { 
                            echo "Waiting for $URL... ($i/${dockerAppHealthMaxCheck})"; sleep ${dockerAppHealthWaitTime}; 
                        }; 
                    done; 
                    if [ "$__DEPLOTN_APP_DEPLOYED__" -eq "1" ]; then
                        echo "Health check failed...";
                        sudo docker logs ${dockerDeploymentAppName};
                    fi
                    exit $__DEPLOTN_APP_DEPLOYED__
                `);
            }
            sshCommands.push(`echo App started successfully, promoting...`);
            const fastRestartScript = `bash -lc '
                sudo docker rm -f ${dockerAppName} && \
                ${actualDockerAppStartCommand} && \
                sudo docker rm -f ${dockerDeploymentAppName} 
            '`;
            sshCommands.push(fastRestartScript);
        } else {
            sshCommands.push(`sudo docker rm -f ${dockerAppName}[::]?`);
            sshCommands.push(actualDockerAppStartCommand);
        }
        sshCommands.push(`echo "Waiting for actual app to be up..."`);
        sshCommands.push(`sleep ${dockerAppProcessWaitTime}`);
        if (dockerAppPrintLog && dockerAppPrintLog != "0") {
            sshCommands.push(`sudo docker logs -n ${dockerAppPrintLog} ${dockerAppName}`);
        }
    }

    // APACHE2
    let apache2AppName = appName;
    if (apache2Configure) {
        let apache2ServerConfigPath = "/etc/apache2/sites-available/";
        const apache2DomainNames: string[] = [];
        apache2AppName = getInput("apache2-app-name", "string", apache2AppName);
        const apache2SetupSsl = getInput("apache2-setup-ssl", "boolean", false);
        const apache2Domains = (getInput("apache2-domains", "array", []) as string[]);
        const apache2ConfigureDomain = getInput("apache2-configure-domain", "boolean", true);
        const apache2AddEnvToDomain = getInput("apache2-add-env-to-domain", "boolean", true);
        const apache2ConfigureDomainWww = getInput("apache2-configure-domain-www", "boolean", false);
        const apache2ConfigPath = getInput("apache2-config-path", "string", environmentVars["APACHE2_CONFIG_PATH"] ?? process.env.APACHE2_CONFIG_PATH ?? "");
        const apache2BaseDomain = getInput("apache2-base-domain", "string", environmentVars["APACHE2_BASE_DOMAIN"] ?? process.env.APACHE2_BASE_DOMAIN ?? baseDomain);
        const apache2Environment = getInput("apache2-environment", "string", environmentVars["APACHE2_ENVIRONMENT"] ?? process.env.APACHE2_ENVIRONMENT ?? environment);
        const apache2AppConfServerAdmin = getInput("apache2-conf-server-admin", "string", environmentVars["APACHE2_CONF_SERVER_ADMIN"] ?? process.env.APACHE2_CONF_SERVER_ADMIN ?? "webmaster@yourdomain.com");

        let apacheConfFileName = `${apache2AppName}-${apache2Environment}.conf`
        apache2ServerConfigPath += apacheConfFileName;
        if (apache2BaseDomain && apache2ConfigureDomain) {
            apache2DomainNames.push(`${apache2AppName}.${apache2AddEnvToDomain && apache2Environment ? (apache2Environment + ".") : ""}${apache2BaseDomain}`);
            if (apache2ConfigureDomainWww) {
                apache2DomainNames.push(`www.${apache2AppName}.${apache2AddEnvToDomain && apache2Environment ? (apache2Environment + ".") : ""}${apache2BaseDomain}`);
            }
        }
        for (const apache2Domain of apache2Domains) {
            const parts = apache2Domain.split("|");
            const domain = parts[0];
            if (parts.length > 1) {
                if (environment !== parts[1]) continue;
            }
            apache2DomainNames.push(`${domain}`);
        }
        let configContent = '';
        if (apache2ConfigPath) {
            configContent = fs.readFileSync(apache2ConfigPath, 'utf8');
        } else {
            const [firstDomain, ...otherDomains] = apache2DomainNames;
            configContent = `<VirtualHost *:80>
    ${apache2DomainNames?.length > 0 ? "ServerName " : ""}${apache2DomainNames?.length > 0 ? firstDomain : ""}
    ${otherDomains?.length > 0 ? "ServerAlias " : ""}${otherDomains.map((d) => (`${d}`)).join(" ")}

    ServerAdmin ${apache2AppConfServerAdmin}

    ProxyPreserveHost On
    ProxyRequests Off

    ProxyPass / http://127.0.0.1:${appPublicPort}/
    ProxyPassReverse / http://127.0.0.1:${appPublicPort}/
</VirtualHost>`
        }
        if (configContent) {
            sshCommands.push(`echo Preparing apache2 configuration...`);
            sshCommands.push(`sudo touch ${apache2ServerConfigPath}`);
            sshCommands.push(`sudo cat << EOF > ${apache2ServerConfigPath}\n${configContent}\nEOF`);
            sshCommands.push(`sudo a2enmod proxy proxy_http headers`);
            sshCommands.push(`sudo a2ensite ${apacheConfFileName}`);
            if (apache2SetupSsl) {
                sshCommands.push(`sudo certbot --apache ${apache2DomainNames.map((d) => (`-d ${d}`)).join(" ")} --non-interactive --agree-tos --keep-until-expiring -m ${apache2AppConfServerAdmin} --expand`);
            }
            sshCommands.push(`sudo systemctl reload apache2`);
        }
    }

    sshPostCommands.forEach((c) => sshCommands.push(`${c}[::]?`));
    sshCommands.push("exit");

    const conn = new Client();
    print("log", "SSH Commands:", sshCommands);
    const sshCommandsQueue = new MicroQueue(sshCommands ?? []);
    const connPayload: any = {
        host: sshHost,
        port: sshPort,
        username: sshUsername,
    }
    if (sshPassword) {
        connPayload.password = sshPassword;
    }
    if (sshPassphrase) {
        connPayload.passphrase = sshPassphrase;
    }
    if (sshPrivateKey) {
        connPayload.privateKey = sshPrivateKey;
    }
    conn.on('ready', async () => {
        const waiter = setTimeout(() => {
            conn.end();
            core.setFailed(`-901`);
            print("log", `Force closing the ssh shell after ${sshRuntimeMinutes} minutes\n`);
        }, sshRuntimeMinutes * 60 * 1000);

        try {
            do {
                let commandString = sshCommandsQueue.dequeue();
                if (!commandString) break;
                const [command, flag] = commandString.split("[::]");
                const exitCode = await execCommand(conn, command, flag);
                if (exitCode !== 0 && flag !== "?") {
                    print("error", `Closed with code - ${exitCode}`);
                    core.setFailed(`${exitCode}`);
                    break;
                }
            } while (sshCommandsQueue.size() > 0);
        } catch (error) {
            const err = error as Error;
            print("error", `Execution Failed: ${err}`);
            core.setFailed(`${err}`);
        } finally {
            conn.end();
            clearTimeout(waiter);
        }
    }).on('error', (err: Error) => {
        print("error", `Connection Error: ${err}`);
        core.setFailed(`-900`);
    }).connect(connPayload);
}

function execCommand(conn: Client, command: string, flag?: string): Promise<number> {
    return new Promise((resolve, reject) => {
        print("log!", (flag ? "(?) " : "") + "$", (verbose ? command : command.split("").slice(0, 100).map((a) => (a == " " ? " " : "*")).join("").replaceAll("\n", "")), "\n");
        conn.exec(command, (err: Error | undefined, stream: ClientChannel) => {
            if (err) {
                return reject(err);
            }

            stream
                .on('close', (code: number) => {
                    if (flag === "?" || code === 0) {
                        resolve(code);
                    } else {
                        reject(code);
                    }
                })
                .on('data', (data: Buffer) => {
                    print("log!", data.toString('utf8'));
                })
                .stderr.on('data', (data: Buffer) => {
                    print("log!", data.toString('utf8'));
                });
        });
    });
}

function executeInstruction(value: string, instruction: string) {
    if (instruction === "UPPER") return value.toUpperCase();
    else if (instruction === "LOWER") return value.toLowerCase();
    else if (instruction === "base64") return Buffer.from(value, "utf8").toString("base64");
    else if (instruction === "sanitize") return Buffer.from(value.replaceAll("\r", "").replaceAll("\n", "~"), "utf8").toString("base64").replaceAll("\n", "~");
    else if (instruction === "desanitize") return Buffer.from(value.replaceAll("~", "\n"), "base64").toString("utf8").replaceAll("~", "\n");
    return value;
}

function expandVariables(value: string) {
    let result = "";
    let activeVar = "";
    for (const c of value) {
        if (c == "$" && activeVar == "") {
            activeVar += c;
            continue;
        } else if (activeVar != "") {
            if (c == "}") {
                result += getInput(activeVar.substring(2));
                activeVar = "";
            } else {
                activeVar += c;
            }
            continue;
        }
        result += c;
    }
    return result;
}

function getInput(name: string, type: string = "string", defaultValue?: any) {
    const value = (__TEST_OBJECT ? __TEST_OBJECT[name] : core.getInput(name));
    if (!value || value == "") {
        return defaultValue;
    }
    if (type === "boolean") {
        return value.toUpperCase() === "TRUE";
    } if (type === "number") {
        return parseInt(value ?? "0");
    } else if (type === "flatten_string") {
        return value.split('\n').join(' ');
    } else if (type === "array" && (typeof value == "string")) {
        return value.split(__TEST_OBJECT ? "\\n" : '\n');
    }
    return value;
}

function print(action: "log" | "log!" | "error" = "log", ...content: any[]) {
    if (action === "log!") {
        process.stdout.write(content.join(" "));
        return;
    }
    if (!verbose) return;
    console[action](...content);
}

function getRandomElement<T>(list: T[]): T {
    if (list.length === 0) {
        throw new Error("Cannot select from an empty array.");
    }
    const randomIndex = Math.floor(Math.random() * list.length);
    return list[randomIndex];
}

function getRandomInt(min: number, max: number): number {
    const minCeiled = Math.ceil(min);
    const maxFloored = Math.floor(max);
    return Math.floor(Math.random() * (maxFloored - minCeiled + 1)) + minCeiled;
}

function generateWithinRange(start: number, end: number, step: number = 1): number[] {
    const result: number[] = [];

    if (start > end) {
        for (let i = start; i >= end; i -= Math.abs(step)) {
            result.push(i);
        }
    } else {
        for (let i = start; i <= end; i += Math.abs(step)) {
            result.push(i);
        }
    }
    return result;
}

function setupTest(argc: number, argv: string[]) {
    __TEST_OBJECT = {};
    for (const arg of argv) {
        if (arg.startsWith("-")) {
            const argParts = arg.split("=");
            __TEST_OBJECT[argParts[0].substring(1)] = argParts[1];
        }
    }
}

main(process.argv.length - 2, process.argv.slice(2));