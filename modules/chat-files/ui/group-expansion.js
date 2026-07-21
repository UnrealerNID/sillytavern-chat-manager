const INTERACTIVE_SELECTOR = 'button, input, label, a, select, textarea';

/**
 * 让分组标题负责展开，箭头只反映当前状态
 * @param {HTMLElement} header 分组标题
 * @param {HTMLElement} indicator 展开状态标识
 * @param {boolean} expanded 是否展开
 * @param {string} label 内容名称
 * @param {()=>void} onToggle 切换回调
 */
export function bindGroupExpansion(header, indicator, expanded, label, onToggle) {
    const action = expanded ? '收起' : '展开';
    header.tabIndex = 0;
    header.setAttribute('aria-expanded', String(expanded));
    header.setAttribute('aria-label', `${action}${label}`);
    header.title = `${action}${label}`;
    const icon = indicator.querySelector('[data-cm-group-chevron]');
    icon?.classList.toggle('fa-chevron-up', expanded);
    icon?.classList.toggle('fa-chevron-down', !expanded);
    header.addEventListener('click', event => {
        if (event.target?.closest?.(INTERACTIVE_SELECTOR)) return;
        onToggle();
    });
    header.addEventListener('keydown', event => {
        if (event.target !== header || !['Enter', ' '].includes(event.key)) return;
        event.preventDefault();
        onToggle();
    });
}
