// Copyright (c) jdneo. All rights reserved.
// Licensed under the MIT license.

import * as cp from "child_process";
import * as fse from "fs-extra";
import * as os from "os";
import * as path from "path";
import * as requireFromString from "require-from-string";
import { ExtensionContext } from "vscode";
import { ConfigurationChangeEvent, Disposable, MessageItem, window, workspace, WorkspaceConfiguration } from "vscode";
import { Endpoint, IProblem, leetcodeHasInited, supportedPlugins } from "./shared";
import { executeCommand, executeCommandWithProgress } from "./utils/cpUtils";
import { DialogOptions, openUrl } from "./utils/uiUtils";
import * as wsl from "./utils/wslUtils";
import { toWslPath, useWsl } from "./utils/wslUtils";

class LeetCodeExecutor implements Disposable {
    private leetCodeRootPath: string;
    private nodeExecutable: string;
    private configurationChangeListener: Disposable;

    constructor() {
        this.leetCodeRootPath = path.join(__dirname, "..", "..", "node_modules", "vsc-leetcode-cli");
        this.nodeExecutable = this.getNodePath();
        this.configurationChangeListener = workspace.onDidChangeConfiguration((event: ConfigurationChangeEvent) => {
            if (event.affectsConfiguration("leetcode.nodePath")) {
                this.nodeExecutable = this.getNodePath();
            }
        }, this);
    }

    public async getLeetCodeBinaryPath(): Promise<string> {
        if (wsl.useWsl()) {
            return `${await wsl.toWslPath(`"${path.join(this.leetCodeRootPath, "bin", "leetcode")}"`)}`;
        }
        return `"${path.join(this.leetCodeRootPath, "bin", "leetcode")}"`;
    }

    public async meetRequirements(context: ExtensionContext): Promise<boolean> {
        const hasInited: boolean | undefined = context.globalState.get(leetcodeHasInited);
        if (!hasInited) {
            await this.removeOldCache();
        }
        if (this.nodeExecutable !== "node") {
            if (!await fse.pathExists(this.nodeExecutable)) {
                throw new Error(`The Node.js executable does not exist on path ${this.nodeExecutable}`);
            }
            // Wrap the executable with "" to avoid space issue in the path.
            this.nodeExecutable = `"${this.nodeExecutable}"`;
            if (useWsl()) {
                this.nodeExecutable = await toWslPath(this.nodeExecutable);
            }
        }
        try {
            await this.executeCommandEx(this.nodeExecutable, ["-v"]);
        } catch (error) {
            const choice: MessageItem | undefined = await window.showErrorMessage(
                "LeetCode extension needs Node.js installed in environment path",
                DialogOptions.open,
            );
            if (choice === DialogOptions.open) {
                openUrl("https://nodejs.org");
            }
            return false;
        }
        for (const plugin of supportedPlugins) {
            try { // Check plugin
                await this.executeCommandEx(this.nodeExecutable, [await this.getLeetCodeBinaryPath(), "plugin", "-e", plugin]);
            } catch (error) { // Remove old cache that may cause the error download plugin and activate
                await this.removeOldCache();
                await this.executeCommandEx(this.nodeExecutable, [await this.getLeetCodeBinaryPath(), "plugin", "-i", plugin]);
            }
        }
        // Set the global state HasInited true to skip delete old cache after init
        context.globalState.update(leetcodeHasInited, true);
        return true;
    }

    public async deleteCache(): Promise<string> {
        return await this.executeCommandEx(this.nodeExecutable, [await this.getLeetCodeBinaryPath(), "cache", "-d"]);
    }

    public async getUserInfo(): Promise<string> {
        return await this.executeCommandEx(this.nodeExecutable, [await this.getLeetCodeBinaryPath(), "user"]);
    }

    public async signOut(): Promise<string> {
        return await this.executeCommandEx(this.nodeExecutable, [await this.getLeetCodeBinaryPath(), "user", "-L"]);
    }

    public async listProblems(showLocked: boolean): Promise<string> {
        return await this.executeCommandEx(this.nodeExecutable, showLocked ?
            [await this.getLeetCodeBinaryPath(), "list"] :
            [await this.getLeetCodeBinaryPath(), "list", "-q", "L"],
        );
    }

    public async showProblem(problemNode: IProblem, language: string, filePath: string, showDescriptionInComment: boolean = false): Promise<void> {
        const templateType: string = showDescriptionInComment ? "-cx" : "-c";

        if (!await fse.pathExists(filePath)) {
            await fse.createFile(filePath);
            const codeTemplate: string = await this.executeCommandWithProgressEx("Fetching problem data...", this.nodeExecutable, [await this.getLeetCodeBinaryPath(), "show", problemNode.id, templateType, "-l", language]);
            await fse.writeFile(filePath, codeTemplate);
        }
    }

    public async showSolution(input: string, language: string): Promise<string> {
        const solution: string = await this.executeCommandWithProgressEx("Fetching top voted solution from discussions...", this.nodeExecutable, [await this.getLeetCodeBinaryPath(), "show", input, "--solution", "-l", language]);
        return solution;
    }

    public async getDescription(problemNodeId: string): Promise<string> {
        return await this.executeCommandWithProgressEx("Fetching problem description...", this.nodeExecutable, [await this.getLeetCodeBinaryPath(), "show", problemNodeId, "-x"]);
    }

    public async listSessions(): Promise<string> {
        return await this.executeCommandEx(this.nodeExecutable, [await this.getLeetCodeBinaryPath(), "session"]);
    }

    public async enableSession(name: string): Promise<string> {
        return await this.executeCommandEx(this.nodeExecutable, [await this.getLeetCodeBinaryPath(), "session", "-e", name]);
    }

    public async createSession(id: string): Promise<string> {
        return await this.executeCommandEx(this.nodeExecutable, [await this.getLeetCodeBinaryPath(), "session", "-c", id]);
    }

    public async deleteSession(id: string): Promise<string> {
        return await this.executeCommandEx(this.nodeExecutable, [await this.getLeetCodeBinaryPath(), "session", "-d", id]);
    }

    public async submitSolution(filePath: string): Promise<string> {
        try {
            return await this.executeCommandWithProgressEx("Submitting to LeetCode...", this.nodeExecutable, [await this.getLeetCodeBinaryPath(), "submit", `"${filePath}"`]);
        } catch (error) {
            if (error.result) {
                return error.result;
            }
            throw error;
        }
    }

    public async testSolution(filePath: string, testString?: string): Promise<string> {
        if (testString) {
            return await this.executeCommandWithProgressEx("Submitting to LeetCode...", this.nodeExecutable, [await this.getLeetCodeBinaryPath(), "test", `"${filePath}"`, "-t", `${testString}`]);
        }
        return await this.executeCommandWithProgressEx("Submitting to LeetCode...", this.nodeExecutable, [await this.getLeetCodeBinaryPath(), "test", `"${filePath}"`]);
    }

    public async switchEndpoint(endpoint: string): Promise<string> {
        switch (endpoint) {
            case Endpoint.LeetCodeCN:
                return await this.executeCommandEx(this.nodeExecutable, [await this.getLeetCodeBinaryPath(), "plugin", "-e", "leetcode.cn"]);
            case Endpoint.LeetCode:
            default:
                return await this.executeCommandEx(this.nodeExecutable, [await this.getLeetCodeBinaryPath(), "plugin", "-d", "leetcode.cn"]);
        }
    }

    public async toggleFavorite(node: IProblem, addToFavorite: boolean): Promise<void> {
        const commandParams: string[] = [await this.getLeetCodeBinaryPath(), "star", node.id];
        if (!addToFavorite) {
            commandParams.push("-d");
        }
        await this.executeCommandWithProgressEx("Updating the favorite list...", "node", commandParams);
    }

    public async getCompaniesAndTagsAndLists(): Promise<{ companies: { [key: string]: string[] }, tags: { [key: string]: string[] }, lists: { [key: string]: string[] } }> {
        // preprocess the plugin source
        const companiesTagsPath: string = path.join(this.leetCodeRootPath, "lib", "plugins", "company.js");
        const companiesTagsSrc: string = (await fse.readFile(companiesTagsPath, "utf8")).replace(
            "module.exports = plugin",
            "module.exports = { COMPONIES, TAGS }",
        );
        const { COMPONIES, TAGS } = requireFromString(companiesTagsSrc, companiesTagsPath);
        const bgAll = {
            '1': ['bg-all'],
            '2': ['bg-all'],
            '3': ['bg-all'],
            '4': ['bg-all'],
            '5': ['bg-all'],
            '7': ['bg-all'],
            '9': ['bg-all'],
            '11': ['bg-all'],
            '12': ['bg-all'],
            '13': ['bg-all'],
            '15': ['bg-all'],
            '18': ['bg-all'],
            '19': ['bg-all'],
            '20': ['bg-all'],
            '21': ['bg-all'],
            '22': ['bg-all'],
            '23': ['bg-all'],
            '24': ['bg-all'],
            '25': ['bg-all'],
            '26': ['bg-all'],
            '31': ['bg-all'],
            '33': ['bg-all'],
            '34': ['bg-all'],
            '35': ['bg-all'],
            '36': ['bg-all'],
            '37': ['bg-all'],
            '39': ['bg-all'],
            '40': ['bg-all'],
            '41': ['bg-all'],
            '42': ['bg-all'],
            '45': ['bg-all'],
            '46': ['bg-all'],
            '47': ['bg-all'],
            '48': ['bg-all'],
            '49': ['bg-all'],
            '51': ['bg-all'],
            '52': ['bg-all'],
            '53': ['bg-all'],
            '54': ['bg-all'],
            '55': ['bg-all'],
            '56': ['bg-all'],
            '59': ['bg-all'],
            '61': ['bg-all'],
            '62': ['bg-all'],
            '64': ['bg-all'],
            '67': ['bg-all'],
            '70': ['bg-all'],
            '72': ['bg-all'],
            '74': ['bg-all'],
            '75': ['bg-all'],
            '76': ['bg-all'],
            '77': ['bg-all'],
            '78': ['bg-all'],
            '79': ['bg-all'],
            '80': ['bg-all'],
            '81': ['bg-all'],
            '83': ['bg-all'],
            '84': ['bg-all'],
            '86': ['bg-all'],
            '88': ['bg-all'],
            '90': ['bg-all'],
            '91': ['bg-all'],
            '92': ['bg-all'],
            '93': ['bg-all'],
            '94': ['bg-all'],
            '95': ['bg-all'],
            '96': ['bg-all'],
            '98': ['bg-all'],
            '100': ['bg-all'],
            '101': ['bg-all'],
            '102': ['bg-all'],
            '103': ['bg-all'],
            '104': ['bg-all'],
            '105': ['bg-all'],
            '106': ['bg-all'],
            '107': ['bg-all'],
            '108': ['bg-all'],
            '109': ['bg-all'],
            '110': ['bg-all'],
            '111': ['bg-all'],
            '112': ['bg-all'],
            '113': ['bg-all'],
            '114': ['bg-all'],
            '116': ['bg-all'],
            '117': ['bg-all'],
            '118': ['bg-all'],
            '119': ['bg-all'],
            '120': ['bg-all'],
            '121': ['bg-all'],
            '122': ['bg-all'],
            '124': ['bg-all'],
            '125': ['bg-all'],
            '127': ['bg-all'],
            '129': ['bg-all'],
            '133': ['bg-all'],
            '136': ['bg-all'],
            '138': ['bg-all'],
            '139': ['bg-all'],
            '140': ['bg-all'],
            '141': ['bg-all'],
            '142': ['bg-all'],
            '143': ['bg-all'],
            '144': ['bg-all'],
            '145': ['bg-all'],
            '146': ['bg-all'],
            '148': ['bg-all'],
            '151': ['bg-all'],
            '152': ['bg-all'],
            '153': ['bg-all'],
            '154': ['bg-all'],
            '155': ['bg-all'],
            '160': ['bg-all'],
            '162': ['bg-all'],
            '165': ['bg-all'],
            '167': ['bg-all'],
            '169': ['bg-all'],
            '173': ['bg-all'],
            '179': ['bg-all'],
            '189': ['bg-all'],
            '198': ['bg-all'],
            '199': ['bg-all'],
            '200': ['bg-all'],
            '203': ['bg-all'],
            '206': ['bg-all'],
            '207': ['bg-all'],
            '208': ['bg-all'],
            '210': ['bg-all'],
            '215': ['bg-all'],
            '216': ['bg-all'],
            '217': ['bg-all'],
            '219': ['bg-all'],
            '220': ['bg-all'],
            '221': ['bg-all'],
            '222': ['bg-all'],
            '224': ['bg-all'],
            '225': ['bg-all'],
            '226': ['bg-all'],
            '230': ['bg-all'],
            '232': ['bg-all'],
            '234': ['bg-all'],
            '235': ['bg-all'],
            '236': ['bg-all'],
            '237': ['bg-all'],
            '238': ['bg-all'],
            '239': ['bg-all'],
            '242': ['bg-all'],
            '268': ['bg-all'],
            '278': ['bg-all'],
            '282': ['bg-all'],
            '284': ['bg-all'],
            '289': ['bg-all'],
            '295': ['bg-all'],
            '297': ['bg-all'],
            '300': ['bg-all'],
            '304': ['bg-all'],
            '322': ['bg-all'],
            '328': ['bg-all'],
            '332': ['bg-all'],
            '344': ['bg-all'],
            '347': ['bg-all'],
            '374': ['bg-all'],
            '380': ['bg-all'],
            '387': ['bg-all'],
            '409': ['bg-all'],
            '412': ['bg-all'],
            '438': ['bg-all'],
            '443': ['bg-all'],
            '448': ['bg-all'],
            '450': ['bg-all'],
            '503': ['bg-all'],
            '542': ['bg-all'],
            '543': ['bg-all'],
            '559': ['bg-all'],
            '560': ['bg-all'],
            '572': ['bg-all'],
            '593': ['bg-all'],
            '606': ['bg-all'],
            '617': ['bg-all'],
            '623': ['bg-all'],
            '658': ['bg-all'],
            '662': ['bg-all'],
            '674': ['bg-all'],
            '687': ['bg-all'],
            '692': ['bg-all'],
            '697': ['bg-all'],
            '700': ['bg-all'],
            '701': ['bg-all'],
            '704': ['bg-all'],
            '707': ['bg-all'],
            '720': ['bg-all'],
            '722': ['bg-all'],
            '739': ['bg-all'],
            '771': ['bg-all'],
            '783': ['bg-all'],
            '785': ['bg-all'],
            '788': ['bg-all'],
            '796': ['bg-all'],
            '797': ['bg-all'],
            '811': ['bg-all'],
            '819': ['bg-all'],
            '865': ['bg-all'],
            '873': ['bg-all'],
            '876': ['bg-all'],
            '905': ['bg-all'],
            '958': ['bg-all'],
            '961': ['bg-all'],
            '973': ['bg-all'],
            '987': ['bg-all'],
            '993': ['bg-all'],
            '1008': ['bg-all'],
        }

        const bgEasy = {
            '1': ['bg-easy'],
            '7': ['bg-easy'],
            '9': ['bg-easy'],
            '13': ['bg-easy'],
            '20': ['bg-easy'],
            '21': ['bg-easy'],
            '26': ['bg-easy'],
            '35': ['bg-easy'],
            '53': ['bg-easy'],
            '67': ['bg-easy'],
            '70': ['bg-easy'],
            '83': ['bg-easy'],
            '88': ['bg-easy'],
            '100': ['bg-easy'],
            '101': ['bg-easy'],
            '104': ['bg-easy'],
            '107': ['bg-easy'],
            '108': ['bg-easy'],
            '110': ['bg-easy'],
            '111': ['bg-easy'],
            '112': ['bg-easy'],
            '118': ['bg-easy'],
            '119': ['bg-easy'],
            '121': ['bg-easy'],
            '122': ['bg-easy'],
            '125': ['bg-easy'],
            '136': ['bg-easy'],
            '141': ['bg-easy'],
            '155': ['bg-easy'],
            '160': ['bg-easy'],
            '167': ['bg-easy'],
            '169': ['bg-easy'],
            '189': ['bg-easy'],
            '198': ['bg-easy'],
            '203': ['bg-easy'],
            '206': ['bg-easy'],
            '217': ['bg-easy'],
            '219': ['bg-easy'],
            '225': ['bg-easy'],
            '226': ['bg-easy'],
            '232': ['bg-easy'],
            '234': ['bg-easy'],
            '235': ['bg-easy'],
            '237': ['bg-easy'],
            '242': ['bg-easy'],
            '268': ['bg-easy'],
            '278': ['bg-easy'],
            '344': ['bg-easy'],
            '374': ['bg-easy'],
            '387': ['bg-easy'],
            '409': ['bg-easy'],
            '412': ['bg-easy'],
            '443': ['bg-easy'],
            '448': ['bg-easy'],
            '543': ['bg-easy'],
            '559': ['bg-easy'],
            '572': ['bg-easy'],
            '606': ['bg-easy'],
            '617': ['bg-easy'],
            '674': ['bg-easy'],
            '687': ['bg-easy'],
            '697': ['bg-easy'],
            '700': ['bg-easy'],
            '704': ['bg-easy'],
            '720': ['bg-easy'],
            '771': ['bg-easy'],
            '783': ['bg-easy'],
            '788': ['bg-easy'],
            '796': ['bg-easy'],
            '811': ['bg-easy'],
            '819': ['bg-easy'],
            '876': ['bg-easy'],
            '905': ['bg-easy'],
            '961': ['bg-easy'],
            '993': ['bg-easy'],
        };

        const bgMedium = {
            '2': ['bg-medium'],
            '3': ['bg-medium'],
            '5': ['bg-medium'],
            '11': ['bg-medium'],
            '12': ['bg-medium'],
            '15': ['bg-medium'],
            '18': ['bg-medium'],
            '19': ['bg-medium'],
            '22': ['bg-medium'],
            '24': ['bg-medium'],
            '31': ['bg-medium'],
            '33': ['bg-medium'],
            '34': ['bg-medium'],
            '36': ['bg-medium'],
            '39': ['bg-medium'],
            '40': ['bg-medium'],
            '46': ['bg-medium'],
            '47': ['bg-medium'],
            '48': ['bg-medium'],
            '49': ['bg-medium'],
            '54': ['bg-medium'],
            '55': ['bg-medium'],
            '56': ['bg-medium'],
            '59': ['bg-medium'],
            '61': ['bg-medium'],
            '62': ['bg-medium'],
            '64': ['bg-medium'],
            '74': ['bg-medium'],
            '75': ['bg-medium'],
            '77': ['bg-medium'],
            '78': ['bg-medium'],
            '79': ['bg-medium'],
            '80': ['bg-medium'],
            '81': ['bg-medium'],
            '86': ['bg-medium'],
            '90': ['bg-medium'],
            '91': ['bg-medium'],
            '92': ['bg-medium'],
            '93': ['bg-medium'],
            '94': ['bg-medium'],
            '95': ['bg-medium'],
            '96': ['bg-medium'],
            '98': ['bg-medium'],
            '102': ['bg-medium'],
            '103': ['bg-medium'],
            '105': ['bg-medium'],
            '106': ['bg-medium'],
            '109': ['bg-medium'],
            '113': ['bg-medium'],
            '114': ['bg-medium'],
            '116': ['bg-medium'],
            '117': ['bg-medium'],
            '120': ['bg-medium'],
            '127': ['bg-medium'],
            '129': ['bg-medium'],
            '133': ['bg-medium'],
            '138': ['bg-medium'],
            '139': ['bg-medium'],
            '142': ['bg-medium'],
            '143': ['bg-medium'],
            '144': ['bg-medium'],
            '146': ['bg-medium'],
            '148': ['bg-medium'],
            '151': ['bg-medium'],
            '152': ['bg-medium'],
            '153': ['bg-medium'],
            '162': ['bg-medium'],
            '165': ['bg-medium'],
            '173': ['bg-medium'],
            '179': ['bg-medium'],
            '199': ['bg-medium'],
            '200': ['bg-medium'],
            '207': ['bg-medium'],
            '208': ['bg-medium'],
            '210': ['bg-medium'],
            '215': ['bg-medium'],
            '216': ['bg-medium'],
            '220': ['bg-medium'],
            '221': ['bg-medium'],
            '222': ['bg-medium'],
            '230': ['bg-medium'],
            '236': ['bg-medium'],
            '238': ['bg-medium'],
            '284': ['bg-medium'],
            '289': ['bg-medium'],
            '300': ['bg-medium'],
            '304': ['bg-medium'],
            '322': ['bg-medium'],
            '328': ['bg-medium'],
            '332': ['bg-medium'],
            '347': ['bg-medium'],
            '380': ['bg-medium'],
            '438': ['bg-medium'],
            '450': ['bg-medium'],
            '503': ['bg-medium'],
            '542': ['bg-medium'],
            '560': ['bg-medium'],
            '593': ['bg-medium'],
            '623': ['bg-medium'],
            '658': ['bg-medium'],
            '662': ['bg-medium'],
            '692': ['bg-medium'],
            '701': ['bg-medium'],
            '707': ['bg-medium'],
            '722': ['bg-medium'],
            '739': ['bg-medium'],
            '785': ['bg-medium'],
            '797': ['bg-medium'],
            '865': ['bg-medium'],
            '873': ['bg-medium'],
            '958': ['bg-medium'],
            '973': ['bg-medium'],
            '987': ['bg-medium'],
            '1008': ['bg-medium'],
        };

        const bgHard = {
            '4': ['bg-hard'],
            '23': ['bg-hard'],
            '25': ['bg-hard'],
            '37': ['bg-hard'],
            '41': ['bg-hard'],
            '42': ['bg-hard'],
            '45': ['bg-hard'],
            '51': ['bg-hard'],
            '52': ['bg-hard'],
            '72': ['bg-hard'],
            '76': ['bg-hard'],
            '84': ['bg-hard'],
            '124': ['bg-hard'],
            '140': ['bg-hard'],
            '145': ['bg-hard'],
            '154': ['bg-hard'],
            '224': ['bg-hard'],
            '239': ['bg-hard'],
            '282': ['bg-hard'],
            '295': ['bg-hard'],
            '297': ['bg-hard'],
        };

        const LISTS = {};

        for (const id in bgAll) {
            LISTS[id] = bgAll[id];
        }

        for (const id in bgEasy) {
            LISTS[id].push(bgEasy[id][0]);
        }

        for (const id in bgMedium) {
            LISTS[id].push(bgMedium[id][0]);
        }

        for (const id in bgHard) {
            LISTS[id].push(bgHard[id][0]);
        }

        return { companies: COMPONIES, tags: TAGS, lists: LISTS };
    }

    public get node(): string {
        return this.nodeExecutable;
    }

    public dispose(): void {
        this.configurationChangeListener.dispose();
    }

    private getNodePath(): string {
        const extensionConfig: WorkspaceConfiguration = workspace.getConfiguration("leetcode", null);
        return extensionConfig.get<string>("nodePath", "node" /* default value */);
    }

    private async executeCommandEx(command: string, args: string[], options: cp.SpawnOptions = { shell: true }): Promise<string> {
        if (wsl.useWsl()) {
            return await executeCommand("wsl", [command].concat(args), options);
        }
        return await executeCommand(command, args, options);
    }

    private async executeCommandWithProgressEx(message: string, command: string, args: string[], options: cp.SpawnOptions = { shell: true }): Promise<string> {
        if (wsl.useWsl()) {
            return await executeCommandWithProgress(message, "wsl", [command].concat(args), options);
        }
        return await executeCommandWithProgress(message, command, args, options);
    }

    private async removeOldCache(): Promise<void> {
        const oldPath: string = path.join(os.homedir(), ".lc");
        if (await fse.pathExists(oldPath)) {
            await fse.remove(oldPath);
        }
    }

}

export const leetCodeExecutor: LeetCodeExecutor = new LeetCodeExecutor();
