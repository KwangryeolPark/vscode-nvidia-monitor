import * as vscode from 'vscode';

const { XMLParser } = require('fast-xml-parser');
const xml_parser = new XMLParser();
const exec = require('child-process-promise').exec;
const nvidia_smi = `nvidia-smi -q -x`;

export function activate(context: vscode.ExtensionContext) {
	var resource_monitor: ResourceMonitor = new ResourceMonitor();
	resource_monitor.startUpdating();
	context.subscriptions.push(resource_monitor);
}

abstract class Resource {
	public _config: vscode.WorkspaceConfiguration;
	protected _isShownByDefault: boolean;
	protected _configKey: string;
	protected _maxWidth: number;

	constructor(config: vscode.WorkspaceConfiguration, isShownByDefault: boolean, configKey: string, maxWidth: number) {
		this._config = config;
		this._isShownByDefault = isShownByDefault;
		this._configKey = configKey;
		this._maxWidth = maxWidth;
	}

	public async getResourceDisplay(): Promise<string | null> {
		if (await this.isShown()) {
			let display: string = await this.getDisplay();
			this._maxWidth = Math.min(this._maxWidth, display.length);
			return display.padEnd(this._maxWidth, ' ');
		}
		return null;
	}

    protected abstract getDisplay(): Promise<string>;

    protected async isShown(): Promise<boolean> {
        return Promise.resolve(this._config.get(`show.${this._configKey}`, true));
    }
}

class GPUResource extends Resource {
	constructor(config: vscode.WorkspaceConfiguration) {
		super(config, true, 'gpu', 30);
	}

	async getDisplay(): Promise<string> {
		let resXML = null;
		let display_str = 'nvidia-smi error';
		
		try {
			resXML = await exec(nvidia_smi, { timeout: 2000 });
		} catch (error) {
			console.error('Error getting GPU info from nvidia-smi', error);
		}

		if (resXML == null) {
			return display_str;
		}

		let res = xml_parser.parse(resXML.stdout).nvidia_smi_log;
		let num_gpu = res['attached_gpus'];
		if (num_gpu == 1) {
			res.gpu = [res.gpu];
		}

		let temperature_unit = this._config.get('temperature_unit', '°C');
		let memory_unit = this._config.get('memory_unit', 'GiB');

		const display_array: string[] = [];
		for (let index = 0; index < num_gpu; index++) {
			res.gpu[index].utilization.gpu_util = res.gpu[index].utilization.gpu_util.replace(' %', '');
			res.gpu[index].fb_memory_usage.used = res.gpu[index].fb_memory_usage.used.replace(' MiB', '');
			res.gpu[index].fb_memory_usage.total = res.gpu[index].fb_memory_usage.total.replace(' MiB', '');
			res.gpu[index].temperature.gpu_temp = res.gpu[index].temperature.gpu_temp.replace(' C', '');
			res.gpu[index].temperature.gpu_target_temperature = res.gpu[index].temperature.gpu_target_temperature.replace(' C', '');

			let utilization = parseInt(res.gpu[index].utilization.gpu_util).toString().padStart(3, ' ');
			let memory_used = '0';
			let memory_total = '0';
			if (memory_unit == 'GiB') {
				memory_used = Math.round(res.gpu[index].fb_memory_usage.used/1024).toString().padStart(2, ' ');
				memory_total = Math.round(res.gpu[index].fb_memory_usage.total/1024).toString().padStart(2, ' ');
			} else {
				memory_used = res.gpu[index].fb_memory_usage.used.toString().padStart(4, ' ');
				memory_total = res.gpu[index].fb_memory_usage.total.toString().padStart(4, ' ');
			}
			let temperature_current = res.gpu[index].temperature.gpu_temp;
			let temperature_target = res.gpu[index].temperature.gpu_target_temperature;
			if (temperature_unit == '°F') {
				temperature_current = Math.round(temperature_current * 9/5 + 32).toString().padStart(3, ' ');
				temperature_target = Math.round(temperature_target * 9/5 + 32).toString().padStart(3, ' ');
			}

			let string = `⚡️G${index}: ${utilization}% ・ ${memory_used}/${memory_total}${memory_unit} ・ ${temperature_current}${temperature_unit}/${temperature_target}${temperature_unit}`;
			display_array.push(string);
		}
		display_str = display_array.join('\t');
		return display_str;
	}
}

class ResourceMonitor {
    private _statusBarItem: vscode.StatusBarItem;
    private _config: vscode.WorkspaceConfiguration;
    private _delimiter: string;
    private _updating: boolean;
    private _resources: Resource[];

	constructor() {
		this._config = vscode.workspace.getConfiguration('nvidiaMonitor');
		this._delimiter = "  ";
		this._updating = false;
		this._statusBarItem = vscode.window.createStatusBarItem(this._config.get('alignment', 'left') === 'left' ? vscode.StatusBarAlignment.Left : vscode.StatusBarAlignment.Right, 100);
		this._statusBarItem.show();

		this._resources = [
			new GPUResource(this._config)
		];
	}

	public startUpdating() {
		if (!this._updating) {
			this._updating = true;
			this.update();
		}
	}

	public stopUpdating() {
		this._updating = false;
	}

	private async update() {
		if (this._updating) {
			this._config = vscode.workspace.getConfiguration('nvidiaMonitor');
			for (let resource of this._resources) {
				resource._config = this._config;
			}

			let proposedAlignment = this._config.get('alignment', 'left') === 'left' ? vscode.StatusBarAlignment.Left : vscode.StatusBarAlignment.Right;
			if (proposedAlignment !== this._statusBarItem.alignment) {
				this._statusBarItem.dispose();
				this._statusBarItem = vscode.window.createStatusBarItem(proposedAlignment, 100);
				this._statusBarItem.show();
			}

			let pendingUpdates: Promise<string | null>[] = this._resources.map(resource => resource.getResourceDisplay());
			this._statusBarItem.text = await Promise.all(pendingUpdates).then(results => {
				return results.filter(result => result !== null).join(this._delimiter);
			})

			setTimeout(() => this.update(), this._config.get('updateInterval', 5000));
		}
	}

	dispose() {
		this.stopUpdating();
		this._statusBarItem.dispose();
	}
}
// This method is called when your extension is deactivated
export function deactivate() {}
