import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile } from 'obsidian';
import Anthropic from '@anthropic-ai/sdk';

interface AITaggerSettings {
	apiKey: string;
	model: string;
	maxTags: number;
	autoApply: boolean;
	language: string;
}

const DEFAULT_SETTINGS: AITaggerSettings = {
	apiKey: '',
	model: 'claude-haiku-4-5-20251001',
	maxTags: 5,
	autoApply: false,
	language: 'auto'
};

export default class AITaggerPlugin extends Plugin {
	settings: AITaggerSettings;
	client: Anthropic | null = null;

	async onload() {
		await this.loadSettings();
		this.initClient();

		// Ribbon icon
		this.addRibbonIcon('tag', 'AI Tagger', async (evt: MouseEvent) => {
			await this.tagCurrentNote();
		});

		// Command: Tag current note
		this.addCommand({
			id: 'tag-current-note',
			name: 'Tag current note with AI',
			editorCallback: async (editor: Editor, view: MarkdownView) => {
				await this.tagCurrentNote();
			}
		});

		// Command: Tag all notes in vault
		this.addCommand({
			id: 'tag-all-notes',
			name: 'Tag all notes in vault',
			callback: async () => {
				await this.tagAllNotes();
			}
		});

		// Settings tab
		this.addSettingTab(new AITaggerSettingTab(this.app, this));
	}

	initClient() {
		if (this.settings.apiKey) {
			this.client = new Anthropic({ apiKey: this.settings.apiKey, dangerouslyAllowBrowser: true });
		}
	}

	async tagCurrentNote() {
		if (!this.client) {
			new Notice('⚠️ Please set your Claude API key in settings');
			return;
		}

		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) {
			new Notice('No active note');
			return;
		}

		const file = view.file;
		if (!file) return;

		new Notice('🤖 Analyzing note...');

		try {
			const content = await this.app.vault.read(file);
			const tags = await this.suggestTags(content);

			if (tags.length === 0) {
				new Notice('No tags suggested');
				return;
			}

			new TagSuggestionModal(this.app, tags, file, this).open();
		} catch (error) {
			new Notice(`Error: ${error.message}`);
		}
	}

	async tagAllNotes() {
		if (!this.client) {
			new Notice('⚠️ Please set your Claude API key in settings');
			return;
		}

		const files = this.app.vault.getMarkdownFiles();
		new Notice(`🤖 Tagging ${files.length} notes...`);

		let processed = 0;
		for (const file of files) {
			try {
				const content = await this.app.vault.read(file);
				if (content.trim().length < 50) continue;

				const tags = await this.suggestTags(content);
				if (tags.length > 0 && this.settings.autoApply) {
					await this.applyTags(file, tags);
				}
				processed++;

				if (processed % 10 === 0) {
					new Notice(`Progress: ${processed}/${files.length}`);
				}
			} catch (error) {
				console.error(`Error tagging ${file.path}:`, error);
			}
		}

		new Notice(`✅ Done! Tagged ${processed} notes`);
	}

	async suggestTags(content: string): Promise<string[]> {
		if (!this.client) return [];

		const truncated = content.slice(0, 3000);
		const langHint = this.settings.language === 'ko'
			? 'Respond with Korean tags.'
			: this.settings.language === 'en'
			? 'Respond with English tags.'
			: 'Detect the language of the content and use the same language for tags.';

		const response = await this.client.messages.create({
			model: this.settings.model,
			max_tokens: 200,
			messages: [{
				role: 'user',
				content: `Analyze this note and suggest up to ${this.settings.maxTags} relevant tags.
${langHint}
Return ONLY a JSON array of tag strings, no # prefix, lowercase, use hyphens for spaces.
Example: ["project-management", "productivity", "goals"]

Note content:
${truncated}`
			}]
		});

		const text = response.content[0].type === 'text' ? response.content[0].text : '';
		const match = text.match(/\[.*\]/s);
		if (!match) return [];

		return JSON.parse(match[0]) as string[];
	}

	async applyTags(file: TFile, tags: string[]) {
		const content = await this.app.vault.read(file);

		// Parse existing frontmatter
		const frontmatterRegex = /^---\n([\s\S]*?)\n---/;
		const match = content.match(frontmatterRegex);

		if (match) {
			// Update existing frontmatter
			const existingTags = match[1].match(/tags:\s*\[(.*)\]/);
			if (existingTags) {
				const current = existingTags[1].split(',').map(t => t.trim().replace(/['"]/g, ''));
				const merged = [...new Set([...current, ...tags])];
				const newFrontmatter = match[1].replace(
					/tags:\s*\[.*\]/,
					`tags: [${merged.map(t => `"${t}"`).join(', ')}]`
				);
				await this.app.vault.modify(file, content.replace(match[0], `---\n${newFrontmatter}\n---`));
			} else {
				const newFrontmatter = match[1] + `\ntags: [${tags.map(t => `"${t}"`).join(', ')}]`;
				await this.app.vault.modify(file, content.replace(match[0], `---\n${newFrontmatter}\n---`));
			}
		} else {
			// Add new frontmatter
			const frontmatter = `---\ntags: [${tags.map(t => `"${t}"`).join(', ')}]\n---\n\n`;
			await this.app.vault.modify(file, frontmatter + content);
		}
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.initClient();
	}
}

class TagSuggestionModal extends Modal {
	tags: string[];
	file: TFile;
	plugin: AITaggerPlugin;
	selected: Set<string>;

	constructor(app: App, tags: string[], file: TFile, plugin: AITaggerPlugin) {
		super(app);
		this.tags = tags;
		this.file = file;
		this.plugin = plugin;
		this.selected = new Set(tags);
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl('h2', { text: '🏷️ Suggested Tags' });
		contentEl.createEl('p', { text: 'Select tags to apply:' });

		const tagContainer = contentEl.createDiv({ cls: 'ai-tagger-tags' });

		this.tags.forEach(tag => {
			const btn = tagContainer.createEl('button', {
				text: `#${tag}`,
				cls: 'ai-tagger-tag selected'
			});
			btn.onclick = () => {
				if (this.selected.has(tag)) {
					this.selected.delete(tag);
					btn.removeClass('selected');
				} else {
					this.selected.add(tag);
					btn.addClass('selected');
				}
			};
		});

		const applyBtn = contentEl.createEl('button', {
			text: 'Apply Selected Tags',
			cls: 'mod-cta'
		});

		applyBtn.onclick = async () => {
			await this.plugin.applyTags(this.file, Array.from(this.selected));
			new Notice(`✅ Applied ${this.selected.size} tags`);
			this.close();
		};
	}

	onClose() {
		this.contentEl.empty();
	}
}

class AITaggerSettingTab extends PluginSettingTab {
	plugin: AITaggerPlugin;

	constructor(app: App, plugin: AITaggerPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display() {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl('h2', { text: 'AI Tagger Settings' });

		new Setting(containerEl)
			.setName('Claude API Key')
			.setDesc('Get your API key at console.anthropic.com')
			.addText(text => text
				.setPlaceholder('sk-ant-...')
				.setValue(this.plugin.settings.apiKey)
				.onChange(async (value) => {
					this.plugin.settings.apiKey = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Model')
			.setDesc('Claude model to use (Haiku is fastest and cheapest)')
			.addDropdown(drop => drop
				.addOption('claude-haiku-4-5-20251001', 'Claude Haiku (Fast & Cheap)')
				.addOption('claude-sonnet-4-6', 'Claude Sonnet (Balanced)')
				.setValue(this.plugin.settings.model)
				.onChange(async (value) => {
					this.plugin.settings.model = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Max Tags')
			.setDesc('Maximum number of tags to suggest per note')
			.addSlider(slider => slider
				.setLimits(1, 10, 1)
				.setValue(this.plugin.settings.maxTags)
				.setDynamicTooltip()
				.onChange(async (value) => {
					this.plugin.settings.maxTags = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Language')
			.setDesc('Language for generated tags')
			.addDropdown(drop => drop
				.addOption('auto', 'Auto-detect')
				.addOption('en', 'English')
				.addOption('ko', 'Korean (한국어)')
				.setValue(this.plugin.settings.language)
				.onChange(async (value) => {
					this.plugin.settings.language = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Auto-apply tags')
			.setDesc('Automatically apply tags without confirmation (for bulk tagging)')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.autoApply)
				.onChange(async (value) => {
					this.plugin.settings.autoApply = value;
					await this.plugin.saveSettings();
				}));

		containerEl.createEl('div', {
			text: '💖 If this plugin saves you time, please consider sponsoring!',
			cls: 'setting-item-description'
		});

		const sponsorLink = containerEl.createEl('a', {
			text: '❤️ Sponsor on GitHub',
			href: 'https://github.com/sponsors/oopsk'
		});
		sponsorLink.style.display = 'block';
		sponsorLink.style.marginTop = '8px';
	}
}
