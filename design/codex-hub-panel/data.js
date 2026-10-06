const HubDemoData = {
  sources:[
    {id:"paper",name:"论文进展",description:"稿件修改、参考文献与讨论记录",mode:"report",active:true},
    {id:"wechat",name:"微信群通知",description:"课题组通知与需要跟进的安排",mode:"feed",active:true},
    {id:"experiment",name:"实验记录",description:"实验计划、变量与结果整理",mode:"list",active:true},
    {id:"ai",name:"AI 动态",description:"工具更新与值得尝试的工作流",mode:"report",active:true},
    {id:"manual",name:"手动记录",description:"个人安排与随手记录",mode:"list",active:true}
  ],
  entries:[
    {id:"e1",source:"paper",title:"铅酸电池稿件：讨论部分修订",date:"10月5日 09:40",summary:"整理讨论部分的论证顺序，明确已完成的修改与仍待确认的问题。",important:true,readVersion:2,done:false,archived:false,versions:[
      {version:3,date:"10月5日 09:40",body:"## 本轮更新\n整理讨论部分的论证顺序，明确已完成的修改与仍待确认的问题。\n\n## 已完成\n- 调整退化路径的论证顺序\n- 统一正文与图注中的术语\n\n## 下一步\n1. 核对实验数据与结论是否对应\n2. 补充局限性与适用范围\n3. 整理下一轮讨论的问题"},
      {version:2,date:"10月4日 15:10",body:"## 修改进展\n已调整退化路径的论证顺序。\n\n## 待确认\n- 正文与图注中的术语还需统一\n- 讨论部分的结论需与实验数据逐项对应"},
      {version:1,date:"10月3日 11:30",body:"## 初始记录\n梳理讨论部分需要修改的内容。\n\n## 修改清单\n1. 调整论证顺序\n2. 统一术语\n3. 补充局限性说明"}
    ]},
    {id:"e2",source:"wechat",title:"课题组例会：准备实验进展",date:"10月5日 08:30",summary:"本周实验进展汇报与下阶段计划安排。",important:true,readVersion:0,done:false,archived:false,versions:[{version:1,date:"10月5日 08:30",body:"## 例会准备\n整理本周实验进展，准备汇报已完成的工作与下一步安排。\n\n## 汇报内容\n- 本周实验的变量与观察结果\n- 数据处理过程中待确认的问题\n- 下阶段实验计划与所需材料\n\n## 待办\n整理一份简短的进展提纲，实验数据以原始记录为准。"}]},
    {id:"e3",source:"experiment",title:"下一轮实验：对照组与变量清单",date:"10月4日 16:20",summary:"整理下一轮实验的对照组设置与变量清单。",important:false,readVersion:0,done:false,archived:false,versions:[{version:1,date:"10月4日 16:20",body:"## 实验计划\n在开始下一轮测试前，逐项核对实验条件与记录方式。\n\n## 检查清单\n1. 明确对照组与实验组的区别\n2. 固定除目标变量外的测试条件\n3. 核对样品编号和测量时间\n4. 保存原始数据与异常备注\n\n## 当前状态\n本条为计划记录，尚未开始实验。"}]},
    {id:"e4",source:"paper",title:"论文参考文献核对清单",date:"10月4日 14:00",summary:"核对参考文献格式、补充缺失文献并检查引用规范。",important:false,readVersion:1,done:true,archived:false,versions:[{version:1,date:"10月4日 14:00",body:"## 核对结果\n第一轮文献格式核对已完成。\n\n## 已完成\n- 统一作者、年份和期刊信息的格式\n- 核对正文引用与文末条目的对应关系\n- 标记需要补充原文依据的引用\n\n## 后续\n稿件有新增内容时，再检查对应引用。"}]},
    {id:"e5",source:"ai",title:"近期 AI 工具更新摘要",date:"10月4日 10:15",summary:"汇总近期主流 AI 工具的更新内容与可能的应用场景。",important:false,readVersion:1,done:false,archived:false,versions:[{version:1,date:"10月4日 10:15",body:"## 本次关注\n整理对研究工作有帮助的工具使用方式。\n\n## 可尝试的工作流\n- 围绕选中的研究记录进行讨论\n- 将讨论结果整理成可追踪的待办\n- 保留来源与历史版本，方便核对修改\n\n## 说明\n本条是界面示例，没有引用实际的产品更新消息。"}]},
    {id:"e6",source:"manual",title:"本周研究安排",date:"10月3日 18:00",summary:"梳理本周的研究任务与时间安排。",important:false,readVersion:1,done:false,archived:false,versions:[{version:1,date:"10月3日 18:00",body:"## 本周重点\n优先完成稿件讨论部分的修改，并整理下一轮实验计划。\n\n## 安排\n1. 核对稿件中的数据与表述\n2. 准备课题组例会提纲\n3. 明确对照组与变量清单\n\n## 留给讨论的问题\n哪些工作已经完成，哪些还需要补充证据？"}]}
  ],
  tasks:[
    {id:"t1",title:"核对实验数据与讨论结论",source:"paper",entryId:"e1",due:"2026-10-08",done:false},
    {id:"t2",title:"整理课题组例会提纲",source:"wechat",entryId:"e2",due:"2026-10-07",done:false},
    {id:"t3",title:"完成第一轮参考文献格式核对",source:"paper",entryId:"e4",due:"",done:true}
  ]
};
