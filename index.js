const fsP = require("fs/promises");
const yaml = require("js-yaml");
const simpleGit = require("simple-git");
const { execSync } = require("child_process");
const { Octokit } = require("octokit");
const { DynamoDBClient, PutItemCommand } = require("@aws-sdk/client-dynamodb");

async function submitGithubPR(inputs) {
  const githubRepo = `https://${process.env.PERSONAL_ACCESS_TOKEN}@github.com/amirulabu/stripe-access.git`;
  const workingDir = "/tmp/stripe-access";

  const prodYml =
    "/tmp/stripe-access/apps/stripe/acct_123DummyStripeAccIdProd.yml";

  execSync("rm -rf /tmp/*", { encoding: "utf8", stdio: "inherit" });

  // git clone the access repo
  const git2 = simpleGit();
  await git2.clone(githubRepo, workingDir);

  //   spawnSync("git", ["clone", githubRepo, workingDir], {
  //     stdio: "pipe",
  //     stderr: "pipe",
  //   });

  // get yml file and load
  const doc = yaml.load(await fsP.readFile(prodYml, "utf8"));

  const newAnalystEmail = inputs.email;

  // add analyst email
  const newRoles = doc.roles.map((v) => {
    switch (inputs.role) {
      case "admin":
      case "analyst":
        if (v.role === inputs.role) {
          v.users.push(newAnalystEmail);
          v.users.sort();
        }
        break;
      case "readonly":
        if (v.role === "view_only") {
          v.users.push(newAnalystEmail);
          v.users.sort();
        }
        break;
      default:
        break;
    }

    return v;
  });

  const newDoc = {
    roles: newRoles,
  };
  // update the yml file
  await fsP.writeFile(prodYml, yaml.dump(newDoc));
  const newBranchName = `new-stripe-access/${newAnalystEmail}`;

  // create a new branch
  const git = simpleGit(workingDir);

  await git
    .addConfig("user.name", "kilee1230")
    .addConfig("user.email", "kilee@seekasia.com");

  await git.checkoutLocalBranch(newBranchName);
  await git.add("--all");
  await git.commit(`Add new email - ${newAnalystEmail} to stripe`);
  await git.removeRemote("origin-stripe-access").catch(() => {});
  await git.addRemote("origin-stripe-access", githubRepo);
  await git.push("origin-stripe-access", newBranchName, ["-u"]);
  await git.removeRemote("origin-stripe-access");

  const octokit = new Octokit({
    auth: process.env.PERSONAL_ACCESS_TOKEN,
  });

  await octokit.request("POST /repos/{owner}/{repo}/pulls", {
    owner: "amirulabu",
    repo: "stripe-access",
    title: `Add new email - ${newAnalystEmail} to stripe`,
    body: "Please pull these awesome changes in!",
    head: newBranchName,
    base: "main",
  });

  await fsP.rm(workingDir, { recursive: true, force: true });
}

async function createAuditLog(uuid, inputs) {
  const ddbClient = new DynamoDBClient();

  const params = {
    TableName: "stripe-access-audit-log",
    Item: {
      id: { S: uuid },
      timestamp: { S: new Date().toISOString() },
      rawEvent: { S: JSON.stringify(inputs) },
    },
  };

  return ddbClient.send(new PutItemCommand(params));
}

exports.handler = async (event, context) => {
  let body;
  let statusCode = 204;
  let requestError = false;
  const headers = {
    "Content-Type": "application/json",
  };

  try {
    const uuid = context.awsRequestId;

    switch (event.routeKey) {
      case "POST /log":
        const requestJSON = JSON.parse(event.body);

        let errorString = "";

        if (!requestJSON.name) errorString = "name is require.";
        if (!requestJSON.email) errorString = "emaiil is require.";
        if (!requestJSON.justification)
          errorString = "justification is require.";
        if (!requestJSON.country) errorString = "country is require.";
        if (!requestJSON.approver) errorString = "approver is require.";
        if (!requestJSON.accessPeriod) errorString = "accessPeriod is require.";
        if (!requestJSON.role) errorString = "role is require.";

        if (errorString) {
          requestError = true;
          throw new Error(errorString);
        }

        await createAuditLog(uuid, requestJSON);

        // if (requestJSON.action) await submitGithubPR(requestJSON);

        await submitGithubPR(requestJSON);
        break;
      default:
        throw new Error(`Unsupported route: "${event.routeKey}."`);
    }
  } catch (err) {
    if (requestError) statusCode = 400;
    else statusCode = 500;

    body = err.message;
  } finally {
    body = JSON.stringify(body);
  }

  return {
    statusCode,
    body,
    headers,
  };
};
