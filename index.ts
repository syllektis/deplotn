
import * as fs from "fs";
import * as process from "process";
import * as core from "@actions/core";
import { spawn } from "child_process";
import * as github from "@actions/github";
import { Client, ConnectConfig, ClientChannel } from 'ssh2';

let __TEST_OBJECT: any = null;
let verbose: undefined | boolean;
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
    verbose = !!getInput("verbose");
    if (process.env.REPO_VARS) {
        let parsed = JSON.parse(process.env.REPO_VARS);
        Object.keys(parsed).forEach((k) => {
            process.env[k] = parsed[k];
        })
    }
    await prepareEnvironmentVars();
    await buildAndPushDockerImage(async () => {
        await executeSshCommands();
    });
}

async function prepareEnvironmentVars() {
    const environmentOutput = getInput("environment-output", "boolean");
    if (!environmentOutput) return;
    const verbose = getInput("verbose");
    const environment = getInput("environment", "string", "main");
    const environmentVarsRaw = getInput("environment-vars", "array") as string[];
    const environmentCasing = (getInput("environment-casing") ?? "").toUpperCase();
    const environmentVarsReadPrefixRaw = getInput("environment-vars-read-prefix") ?? "";
    const environmentVarsWritePrefixRaw = getInput("environment-vars-write-prefix") ?? "";
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
    if (verbose !== undefined) {
        const environmentVarsOutputs = Object.keys(environmentVars).reduce((acc: any, k) => {
            acc[environmentVarsWritePrefix + k] = environmentVars[k];
            return acc;
        }, {});
        console.log("ENV=", environment);
        console.log("ENV-CASING=", environmentCasing);
        console.log("ENV-VARS-READ-PREFIX - (PRE)=", environmentVarsReadPrefixRaw);
        console.log("ENV-VARS-READ-PREFIX - (POST)=", environmentVarsReadPrefix);
        console.log("ENV-VARS-WRITE-PREFIX - (PRE)=", environmentVarsWritePrefixRaw);
        console.log("ENV-VARS-WRITE-PREFIX - (POST)=", environmentVarsWritePrefix);
        console.log("ENV-VARS= (PRE)", environmentVarsRaw);
        console.log("ENV-VARS= (POST)", environmentVars);
        console.log("ENV-VARS-OUTPUT=", environmentVarsOutputs);
    }
    Object.keys(environmentVars).forEach((key) => {
        core.setOutput(environmentVarsWritePrefix + key, environmentVars[key]);
        __ENVIRONMENT_VARS[environmentVarsWritePrefix + key] = environmentVars[key];
    });
    core.setOutput("env-setup-completed", true);
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
    const sshRuntimeMinutes = getInput("ssh-runtime-minutes", "number", 10);
    const environmentCasing = (getInput("environment-casing") ?? "").toUpperCase();
    const environmentVarsRaw = getInput("ssh-expose-vars", "array", []) as string[];
    const environmentVarsReadPrefixRaw = getInput("environment-vars-read-prefix") ?? "";
    const environmentVarsReadPrefix = executeInstruction(expandVariables(environmentVarsReadPrefixRaw), environmentCasing);
    const environmentVars: { [key: string]: string; } = ["SSH_HOST", "SSH_PORT", "SSH_USERNAME", "SSH_PASSWORD", "SSH_PRIVATEKEY", "SSH_CONNECTION"].concat(...environmentVarsRaw).reduce((acc: any, key: string) => {
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
    const sshHost = getInput("ssh-host", "string", environmentVars["SSH_HOST"] ?? process.env.SSH_HOST ?? sshConnectionHost ?? "");
    const sshPort = getInput("ssh-port", "string", environmentVars["SSH_PORT"] ?? process.env.SSH_PORT ?? sshConnectionPort ?? "");
    const sshPassphrase = getInput("ssh-passphrase", "string", environmentVars["SSH_PASSPHRASE"] ?? process.env.SSH_PASSPHRASE ?? "");
    const sshPrivateKey = getInput("ssh-privatekey", "string", environmentVars["SSH_PRIVATEKEY"] ?? process.env.SSH_PRIVATEKEY ?? "");
    const sshCommands = environmentVarsSshCommands.concat((getInput("ssh-commands", "array", []) as string[]).map((c) => `${c}[::]?`));
    const sshUsername = getInput("ssh-username", "string", environmentVars["SSH_USERNAME"] ?? process.env.SSH_USERNAME ?? sshConnectionUsername ?? "");
    const sshPassword = getInput("ssh-password", "string", environmentVars["SSH_PASSWORD"] ?? process.env.SSH_PASSWORD ?? sshConnectionPassword ?? "");

    if (!sshHost || !sshCommands.length) {
        return;
    }
    const port = getInput("port", "string", environmentVars["PORT"] ?? process.env.PORT ?? "");
    const appName = getInput("app-name", "string", environmentVars["APP_NAME"] ?? process.env.APP_NAME ?? "");
    const environment = getInput("environment", "string", environmentVars["ENVIRONMENT"] ?? process.env.ENVIRONMENT ?? "");
    const containerPort = getInput("container-port", "string", environmentVars["CONTAINER_PORT"] ?? process.env.CONTAINER_PORT ?? port);
    console.log("SSH Variables:", "Host=" + sshHost, "Port=" + sshPort, "Username=" + sshUsername, "Password=" + (sshPassword ?? "*")[0] + "*******");
    const appPublicPort = getInput("app-public-port", "string", environmentVars["APP_PUBLIC_PORT"] ?? process.env.APP_PUBLIC_PORT ?? containerPort ?? port);

    if (dokkuDeploy) {
        const dokkuSetupSsl = getInput("dokku-setup-ssl", "boolean", false);
        const dokkuDomains = (getInput("dokku-domains", "array", []) as string[]);
        const dokkuEnvironmentVars = getInput("dokku-environment-vars", "array", []);
        const dokkuAddEnvToDomain = getInput("dokku-add-env-to-domain", "boolean", true);
        const envIsNamespace = getInput("environment-is-image-namespace", "boolean", false);
        const baseDomain = getInput("base-domain", "string", environmentVars["BASE_DOMAIN"] ?? process.env.BASE_DOMAIN ?? "");
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

    let dockerAppName = appName;
    if (dockerDeploy) {
        dockerAppName = getInput("docker-app-name", "string", dockerAppName);
        const dockerImageNoCache = getInput("docker-image-nocache", "boolean", true);
        const dockerAppHealthCheck = getInput("docker-app-health-check", "boolean", true);
        const dockerRegistries = (getInput("docker-registries", "array", []) as string[]);
        const dockerEnvironmentVarsRaw = getInput("docker-app-env-vars", "array", []) as string[];
        const dockerAppHealthUrls = (getInput("docker-app-health-urls", "array", []) as string[]);
        const dockerImageLocation = getInput("docker-image-location", "string", environmentVars["DOCKER_IMAGE_LOCATION"] ?? process.env.DOCKER_IMAGE_LOCATION ?? "");
        const dockerAppHealthWaitTime = getInput("docker-app-health-wait-time", "number", environmentVars["DOCKER_APP_HEALTH_WAIT_TIME"] ?? process.env.DOCKER_APP_HEALTH_WAIT_TIME ?? 5);
        const dockerAppHealthMaxCheck = getInput("docker-app-health-max-check", "number", environmentVars["DOCKER_APP_HEALTH_MAX_CHECK"] ?? process.env.DOCKER_APP_HEALTH_MAX_CHECK ?? 12);

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
        console.log("THE VALUES ARE ---- OMG", dockerEnvironmentVarsRaw);
        for (const dockerEnvironmentVar of dockerEnvironmentVarsRaw) {
            const value = (environmentVars[dockerEnvironmentVar] ?? process.env[dockerEnvironmentVar] ?? "");
            console.log("THE VALUES ARE ----", dockerEnvironmentVar, value);
            if (value.includes("=") && value.includes("\n")) {
                const dockerEnvironmentVarParts = value.split("\n");
                for (const dockerEnvironmentVarPart of dockerEnvironmentVarParts) {
                    console.log("THE VALUES ARE ----", dockerEnvironmentVarPart);
                    dockerAppEnvVar += ` -e ${dockerEnvironmentVarPart.replaceAll("\r", "")}`;
                }
            } else {
                dockerAppEnvVar += ` -e ${dockerEnvironmentVar}=${value}`;
            }
        }
        console.log("THE VALUES ARE ---- FINAL", dockerAppEnvVar);
        const realDockerAppName = (dockerAppHealthCheck ? `${dockerAppName}_deploying` : dockerAppName);
        sshCommands.push(`sudo docker run -d ${dockerAppEnvVar} --name ${realDockerAppName} -p ${appPublicPort}:${containerPort} ${dockerImageLocation}`);

        if (!dockerAppHealthUrls.length && dockerAppHealthCheck) {
            dockerAppHealthUrls.push(`http://127.0.0.1:${appPublicPort}`);
        }
        for (const dockerAppHealthUrl of dockerAppHealthUrls) {
            sshCommands.push(`echo Checking if app has been successfully deployed...`);
            sshCommands.push(`URL="${dockerAppHealthUrl}"; __DEPLOTYN_APP_DEPLOYED__=1; for i in {1..${dockerAppHealthMaxCheck}}; do curl -sf "$URL" > /dev/null && __DEPLOTYN_APP_DEPLOYED__=0 && break || { echo "Waiting for $URL... ($i/${dockerAppHealthMaxCheck})"; sleep ${dockerAppHealthWaitTime}; }; done; echo "__DEPLOTYN_APP_DEPLOYED__=$__DEPLOTYN_APP_DEPLOYED__"`);
        }
    }

    sshCommands.push("exit");

    const conn = new Client();
    console.log("SSH Commands:", sshCommands);
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
        print("log!", (flag ? "(?) " : "") + "$", command, "\n");
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
    if (verbose === undefined) {
        verbose = !!getInput("verbose");
    }
    if (!verbose) return;
    if (action === "log!") {
        process.stdout.write(content.join(" "));
        return;
    }
    console[action](...content);
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