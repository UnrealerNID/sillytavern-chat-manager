import { describePart } from '../chat/splitter.js';

/**
 * 管理分卷预览、执行和恢复任务弹窗
 */
export class SplitDialogs {
    /**
     * @param {object} options 依赖项
     * @param {import('./templates.js').UiTemplates} options.ui UI 模板工具
     * @param {import('../chat/splitter.js').SplitService} options.splitter 分卷服务
     * @param {()=>boolean} options.isGenerating 是否正在生成
     * @param {()=>Promise<void>} options.refresh 刷新聊天列表
     * @param {(type:string,message:string)=>void} options.notify 消息提示
     */
    constructor({ ui, splitter, isGenerating, refresh, notify }) {
        Object.assign(this, { ui, splitter, isGenerating, refresh, notify });
        this.activeClose = null;
        this.activeRoot = null;
        this.activeSync = null;
    }

    /**
     * 同步当前分卷弹窗的运行状态
     */
    updateRuntimeState() {
        if (this.activeRoot?.isConnected) this.activeSync?.();
    }

    /**
     * @param {object} record 来源聊天
     * @param {object} initialOptions 初始分卷配置
     */
    async open(record, initialOptions = {}) {
        if (this.isGenerating()) return this.notify('warning', '聊天正在生成，当前不能分卷');
        this.activeClose?.();
        const incremental = Boolean(initialOptions.incremental);
        const dialog = this.ui.dialog([
            incremental ? '继续分卷' : '创建分卷',
            record.ownerName,
            initialOptions.outputRootChatId ?? record.fileId,
        ], 'split');
        this.activeRoot = dialog.root;
        this.activeClose = dialog.close;
        const summary = this.ui.mount(dialog.body, '[data-cm-split-summary]');
        const previewStatus = this.ui.mount(dialog.body, '[data-cm-split-preview-status]');
        const previewDetail = this.ui.mount(dialog.body, '[data-cm-split-preview-detail]');
        const groupConfigField = this.ui.mount(dialog.body, '[data-cm-split-group-config-field]');
        const groupConfig = this.ui.mount(dialog.body, '[data-cm-split-group-config]', HTMLSelectElement);
        const start = this.ui.mount(dialog.body, '[data-cm-split-start]', HTMLInputElement);
        const end = this.ui.mount(dialog.body, '[data-cm-split-end]', HTMLInputElement);
        const chunk = this.ui.mount(dialog.body, '[data-cm-split-chunk]', HTMLInputElement);
        const preview = this.ui.mount(dialog.body, '[data-cm-split-preview]');
        const confirm = this.ui.mount(dialog.body, '[data-cm-split-confirm]', HTMLButtonElement);
        const stop = this.ui.mount(dialog.body, '[data-cm-split-stop]', HTMLButtonElement);
        const maxFloor = Math.max(0, record.messageCount - 1);
        const initialStart = Number(initialOptions.start ?? 0);
        const initialEnd = Number(initialOptions.end ?? maxFloor);
        const fixed = initialOptions.mode === 'fixed';
        const defaultChunk = Math.min(500, Math.max(1, record.messageCount));
        const initialChunk = fixed ? Number(initialOptions.chunkSize ?? defaultChunk) : '';
        summary.textContent = incremental
            ? `增量来源：最后一卷新增楼层 · 本地 #${initialStart}–#${initialEnd}${fixed ? ` · 每卷 ${initialChunk} 层` : ''}`
            : `原聊天 ${record.fileSize} · ${record.messageCount} 层 · 可用范围 #0–#${maxFloor}`;
        this.ui.configureNumberInput(start, initialStart, 0, maxFloor);
        this.ui.configureNumberInput(end, initialEnd, 0, maxFloor);
        chunk.value = String(initialChunk);
        chunk.min = '1';
        chunk.max = String(Math.max(1, record.messageCount));
        chunk.step = '1';
        const groupConfigs = Array.isArray(initialOptions.groupConfigs) ? initialOptions.groupConfigs : [];
        if (incremental) {
            groupConfigField.classList.remove('cm-hidden');
            groupConfigs.forEach((config, index) => {
                groupConfig.append(new Option(`固定楼层 · 每卷 ${config.chunkSize} 层`, String(index)));
            });
        }

        let plan = null;
        let stableSource = null;
        let previewTimer = null;
        let previewController = null;
        let previewRevision = 0;
        let previewing = false;
        let executing = false;

        const syncGroupConfig = () => {
            if (!incremental) return;
            const index = chunk.value === ''
                ? -1
                : groupConfigs.findIndex(config => Number(config.chunkSize) === Number(chunk.value));
            if (index >= 0) {
                groupConfig.value = String(index);
                return;
            }
            let custom = groupConfig.querySelector('option[value="custom"]');
            if (!custom) {
                custom = new Option('自定义配置', 'custom');
                groupConfig.append(custom);
            }
            groupConfig.value = 'custom';
        };
        const setPreviewStatus = (text, state = '') => {
            previewStatus.textContent = text;
            previewStatus.dataset.state = state;
        };
        const readOptions = () => {
            const hasChunk = chunk.value.trim() !== '';
            const invalidRange = [start, end]
                .some(input => input.value === '' || !input.checkValidity());
            if (invalidRange || (hasChunk && !chunk.checkValidity())) {
                throw new Error('请输入有效的楼层范围');
            }
            return {
                mode: hasChunk ? 'fixed' : 'range',
                start: Number(start.value),
                end: Number(end.value),
                chunkSize: hasChunk ? Number(chunk.value) : undefined,
                sequenceStart: initialOptions.sequenceStart,
                incremental,
                outputRootChatId: initialOptions.outputRootChatId,
                rangeOffset: initialOptions.rangeOffset,
            };
        };
        const syncControls = () => {
            const blocked = executing || this.isGenerating() || this.splitter.running;
            for (const input of [start, end, chunk, groupConfig]) input.disabled = blocked;
            confirm.disabled = blocked || previewing || !plan;
        };
        const runPreview = async revision => {
            if (revision !== previewRevision || executing) return;
            let options;
            try {
                options = readOptions();
            } catch (error) {
                plan = null;
                setPreviewStatus('参数有误', 'error');
                preview.replaceChildren(this.ui.state(error.message, { error: true }));
                return syncControls();
            }
            const controller = new AbortController();
            previewController = controller;
            const abortPreview = () => controller.abort();
            dialog.signal.addEventListener('abort', abortPreview, { once: true });
            previewing = true;
            setPreviewStatus('正在更新', 'loading');
            preview.replaceChildren(this.ui.state(stableSource ? '正在计算新的分卷方案…' : '正在读取原聊天并计算预览…'));
            syncControls();
            try {
                const nextPlan = await this.splitter.prepare(record, options, controller.signal, stableSource);
                if (revision !== previewRevision || controller.signal.aborted) return;
                plan = nextPlan;
                stableSource ??= nextPlan.source;
                preview.replaceChildren(...plan.parts.map(part => this.ui.splitPart(describePart(part))));
                const messageCount = plan.parts
                    .reduce((sum, part) => sum + part.messages.length, 0);
                previewDetail.textContent = `${plan.parts.length} 个分卷 · 共 ${messageCount} 层`;
                setPreviewStatus('预览已更新', 'ready');
            } catch (error) {
                if (controller.signal.aborted || dialog.signal.aborted || revision !== previewRevision) return;
                plan = null;
                previewDetail.textContent = '';
                setPreviewStatus('无法预览', 'error');
                preview.replaceChildren(this.ui.state(error.message, { error: true }));
            } finally {
                dialog.signal.removeEventListener('abort', abortPreview);
                if (revision === previewRevision) {
                    previewing = false;
                    previewController = null;
                    syncControls();
                }
            }
        };
        const schedulePreview = (delay = 300) => {
            if (executing) return;
            const revision = ++previewRevision;
            if (previewTimer !== null) clearTimeout(previewTimer);
            previewController?.abort();
            previewController = null;
            previewing = false;
            plan = null;
            previewDetail.textContent = '';
            setPreviewStatus(delay ? '等待更新' : '正在更新', 'loading');
            preview.replaceChildren(this.ui.state(delay ? '参数修改中，稍后自动更新预览…' : '正在准备预览…'));
            syncControls();
            previewTimer = setTimeout(() => {
                previewTimer = null;
                void runPreview(revision);
            }, delay);
        };

        this.ui.bindButton(confirm, async () => {
            if (!plan) return;
            if (this.isGenerating()) return this.notify('warning', '聊天正在生成，不能写入分卷');
            let refreshSource = false;
            executing = true;
            if (previewTimer !== null) clearTimeout(previewTimer);
            previewController?.abort();
            setPreviewStatus('正在创建', 'loading');
            syncControls();
            stop.classList.remove('cm-hidden');
            dialog.setClosable(false);
            try {
                const task = await this.splitter.execute(plan, {
                    shouldPause: () => this.isGenerating(),
                    onUpdate: current => this.#renderTask(preview, current),
                });
                this.#renderTask(preview, task);
                plan = null;
                const completed = task.status === 'complete';
                setPreviewStatus(completed ? '创建完成' : '任务已暂停', completed ? 'ready' : 'warning');
                previewDetail.textContent = task.status === 'complete' ? '所有分卷均已写入并校验' : '可以从恢复任务继续执行';
                this.notify(
                    completed ? 'success' : 'warning',
                    completed ? '分卷完成' : '任务已安全暂停',
                );
                await this.refresh();
            } catch (error) {
                setPreviewStatus('创建失败', 'error');
                this.notify('error', error.message);
                if (error.task) this.#renderTask(preview, error.task);
                refreshSource = error.message.includes('原聊天在预览后发生变化');
            } finally {
                dialog.setClosable(true);
                stop.classList.add('cm-hidden');
                executing = false;
                syncControls();
                if (refreshSource) {
                    stableSource = null;
                    schedulePreview(0);
                }
            }
        });
        this.ui.bindButton(stop, () => this.splitter.requestStop());
        for (const input of [start, end]) input.addEventListener('input', () => schedulePreview());
        chunk.addEventListener('input', () => {
            syncGroupConfig();
            schedulePreview();
        });
        groupConfig.addEventListener('change', () => {
            if (groupConfig.value === 'custom') return;
            const config = groupConfigs[Number(groupConfig.value)];
            if (!config) return;
            chunk.value = String(config.chunkSize);
            schedulePreview();
        });
        dialog.signal.addEventListener('abort', () => {
            if (previewTimer !== null) clearTimeout(previewTimer);
            previewController?.abort();
            if (this.activeRoot === dialog.root) {
                this.activeClose = null;
                this.activeRoot = null;
                this.activeSync = null;
            }
        }, { once: true });
        this.activeSync = syncControls;
        syncGroupConfig();
        syncControls();
        schedulePreview(0);
    }

    /**
     * 显示未完成任务
     * @param {object[]} tasks 未完成任务
     */
    async showRecovery(tasks) {
        if (!tasks.length) return;
        const dialog = this.ui.dialog('检测到未完成的分卷任务', 'recovery');
        const list = this.ui.mount(dialog.body, '[data-cm-recovery-list]');
        for (const task of tasks) {
            const card = this.ui.component('recovery-task');
            const name = this.ui.mount(card, '[data-cm-recovery-name]');
            const parts = this.ui.mount(card, '[data-cm-recovery-parts]');
            name.textContent = `${task.record.ownerName} / ${task.record.fileId}`;
            parts.textContent = task.parts
                .map(part => `${part.fileId}：${part.status}`)
                .join('；');
            const resume = this.ui.mount(card, '[data-cm-recovery-resume]', HTMLButtonElement);
            const clear = this.ui.mount(card, '[data-cm-recovery-clear]', HTMLButtonElement);
            this.ui.bindButton(resume, async () => {
                if (this.isGenerating()) return this.notify('warning', '聊天正在生成，不能继续任务');
                resume.disabled = true;
                try {
                    const plan = await this.splitter.restorePlan(task);
                    await this.splitter.execute(plan, { resumeTask: task, shouldPause: () => this.isGenerating() });
                    card.remove();
                    this.notify('success', '任务已完成');
                    await this.refresh();
                } catch (error) {
                    this.notify('error', error.message);
                } finally {
                    resume.disabled = false;
                }
            });
            this.ui.bindButton(clear, async () => {
                await this.splitter.journal.remove(task.id);
                card.remove();
            });
            list.append(card);
        }
    }

    #renderTask(container, task) {
        container.replaceChildren(...task.parts.map(part => this.ui.splitPart(
            `${part.fileId}　${part.status}${part.error ? `：${part.error}` : ''}`,
            part.status,
        )));
    }
}
