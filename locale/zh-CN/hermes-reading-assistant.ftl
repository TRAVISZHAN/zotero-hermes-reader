# 这两条消息只能提供属性，不能提供消息值（`= 文本`）。
# Fluent 在有值时会把宿主元素的 textContent 整体替换掉：
# collapsible-section 的 head 和 <div data-type="body"> 会被一起删掉，
# 侧栏区块因此变成一行纯文字；sidenav 按钮也会在图标上叠一层文字。
hermes-reading-assistant-section-header =
    .label = Hermes 阅读助手
hermes-reading-assistant-sidenav =
    .tooltiptext = Hermes 阅读助手
