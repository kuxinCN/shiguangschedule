/**
 * 广州职业技术大学 - 强智综合教务系统课表适配脚本
 * 适用平台：时荒课表 (ShiGuangSchedule)
 */
(async function () {
    console.log("[时荒课表] 开始执行广州职业技术大学强智教务系统课表解析脚本...");

    /**
     * 辅助工具：在当前 document 及所有可访问的 iframe 中深度查找课表 Table
     */
    function findScheduleTable(doc) {
        if (!doc) return null;

        // 1. 尝试直接通过已知 ID 或 Class 寻找
        let table = doc.getElementById("kbtable") || doc.querySelector("table.kbtable");
        if (table) return { table: table, doc: doc };

        // 2. 遍历所有 table，依据表头特征文本进行识别
        const tables = doc.querySelectorAll("table");
        for (let i = 0; i < tables.length; i++) {
            const t = tables[i];
            const text = t.textContent || "";
            if (text.includes("星期一") && text.includes("星期二") && (text.includes("节") || text.includes("时间模式"))) {
                return { table: t, doc: doc };
            }
        }

        // 3. 递归穿透当前页面内的所有 iframe
        const iframes = doc.querySelectorAll("iframe, frame");
        for (let j = 0; j < iframes.length; j++) {
            try {
                const subDoc = iframes[j].contentDocument || iframes[j].contentWindow?.document;
                if (subDoc) {
                    const result = findScheduleTable(subDoc);
                    if (result) return result;
                }
            } catch (e) {
                // 忽略跨域等受限 iframe
            }
        }

        return null;
    }

    /**
     * 展开并解析周次字符串
     * 如: "2-4,6,9-12(周)" -> [2, 3, 4, 6, 9, 10, 11, 12]
     * 如: "1-15(单周)" -> [1, 3, 5, ..., 15]
     */
    function parseWeeks(weekStr) {
        if (!weekStr) return [];
        const isOddOnly = weekStr.includes("单");
        const isEvenOnly = weekStr.includes("双");

        const numPartMatch = weekStr.match(/([0-9\-,]+)/);
        if (!numPartMatch) return [];

        const parts = numPartMatch[1].split(",");
        const weekSet = new Set();

        parts.forEach(part => {
            if (part.includes("-")) {
                const range = part.split("-");
                const start = parseInt(range[0], 10);
                const end = parseInt(range[1], 10);
                if (!isNaN(start) && !isNaN(end)) {
                    for (let w = Math.min(start, end); w <= Math.max(start, end); w++) {
                        if (isOddOnly && w % 2 === 0) continue;
                        if (isEvenOnly && w % 2 !== 0) continue;
                        weekSet.add(w);
                    }
                }
            } else {
                const singleWeek = parseInt(part, 10);
                if (!isNaN(singleWeek)) {
                    weekSet.add(singleWeek);
                }
            }
        });

        return Array.from(weekSet).sort((a, b) => a - b);
    }

    /**
     * 尝试在网页中查找课表表格并开始解析
     */
    const found = findScheduleTable(document);

    if (!found) {
        // 未检测到课表页面，友好引导用户
        const currentUrl = window.location.href;
        if (currentUrl.includes("/framework/xsMain.jsp") || currentUrl.includes("/framework/")) {
            window.shiguangBridge.showToast("正在自动前往学期理论课表页面...");
            setTimeout(() => {
                window.location.href = "/jsxsd/xskb/xskb_list.do";
            }, 300);
            return;
        } else if (currentUrl.includes("login") || document.querySelector("input[type='password']")) {
            window.shiguangBridge.showToast("请先输入学号密码登录教务系统");
            return;
        } else {
            const confirmed = await window.shiguangBridgePromise.showAlert(
                "课表指引",
                "未能自动定位到课表，请在菜单中打开【培养管理】➜【我的课表】➜【学期理论课表】，然后点击右下角按钮导入。",
                "直接打开课表"
            );
            if (confirmed) {
                window.location.href = "/jsxsd/xskb/xskb_list.do";
            }
            return;
        }
    }

    const table = found.table;
    const targetDoc = found.doc;
    console.log("[时荒课表] 成功找到课表表格，开始解析 DOM...");

    const rows = Array.from(table.querySelectorAll("tr"));
    if (rows.length === 0) {
        await window.shiguangBridgePromise.showAlert("导入提示", "课表表格为空，请等待课表页面加载完成后再试。", "好的");
        return;
    }

    // 1. 寻找表头，确定星期一到星期日对应的列索引 (1~7)
    let headerRowIndex = -1;
    let dayColumnMap = {}; // colIndex -> day (1..7)
    const dayKeywords = [
        { text: "一", day: 1 },
        { text: "二", day: 2 },
        { text: "三", day: 3 },
        { text: "四", day: 4 },
        { text: "五", day: 5 },
        { text: "六", day: 6 },
        { text: "日", day: 7 },
        { text: "天", day: 7 }
    ];

    for (let r = 0; r < rows.length; r++) {
        const ths = Array.from(rows[r].children);
        let foundDaysInRow = 0;
        const tempMap = {};

        ths.forEach((cell, colIdx) => {
            const text = (cell.textContent || "").trim();
            for (const item of dayKeywords) {
                if (text.includes("星期" + item.text) || text === "周" + item.text) {
                    tempMap[colIdx] = item.day;
                    foundDaysInRow++;
                    break;
                }
            }
        });

        if (foundDaysInRow >= 5) {
            headerRowIndex = r;
            dayColumnMap = tempMap;
            break;
        }
    }

    // 若未通过表头匹配，采用常规降级方案（第一列为节次，第2-8列为周一到周日）
    if (headerRowIndex === -1) {
        headerRowIndex = 0;
        for (let d = 1; d <= 7; d++) {
            dayColumnMap[d] = d;
        }
    }

    console.log("[时荒课表] 表头行号:", headerRowIndex, "星期映射:", JSON.stringify(dayColumnMap));

    // 2. 遍历课表各行与单元格
    const parsedCourses = [];

    for (let r = headerRowIndex + 1; r < rows.length; r++) {
        const tr = rows[r];
        const cells = Array.from(tr.children);

        // 获取该行第一列文本以推测大节次信息（如“第1-2节”）
        let rowDefaultStartSection = 1;
        let rowDefaultEndSection = 2;
        const rowHeaderCellText = (cells[0]?.textContent || "").trim();
        const rowSecMatch = rowHeaderCellText.match(/第?(\d{1,2})-(\d{1,2})节?/);
        if (rowSecMatch) {
            rowDefaultStartSection = parseInt(rowSecMatch[1], 10);
            rowDefaultEndSection = parseInt(rowSecMatch[2], 10);
        }

        cells.forEach((td, colIdx) => {
            const day = dayColumnMap[colIdx];
            if (!day) return; // 非星期列，跳过

            // 优先查找包含课程正文的容器，强智系统通常使用 .kbcontent 或 .kbcontent1
            const contentContainer = td.querySelector(".kbcontent") || td.querySelector(".kbcontent1") || td;
            
            // 将内部的 <br> 替换为换行符
            const clone = contentContainer.cloneNode(true);
            const brs = clone.querySelectorAll("br, p, div");
            brs.forEach(br => br.replaceWith("\n"));

            const rawText = clone.textContent || "";
            if (!rawText.trim()) return;

            // 强智系统同一个格子内有多门课程时，使用连续短横线（---------------------）隔开
            const courseBlocks = rawText.split(/[-]{5,}/);

            courseBlocks.forEach(block => {
                const lines = block
                    .split("\n")
                    .map(l => l.trim())
                    .filter(l => l.length > 0);

                if (lines.length === 0) return;

                // 寻找包含周次和节次信息的“锚点行”
                let ruleLineIndex = -1;
                for (let i = 0; i < lines.length; i++) {
                    const l = lines[i];
                    if (l.includes("周") || /\[\d{1,2}-\d{1,2}节?\]/.test(l)) {
                        ruleLineIndex = i;
                        break;
                    }
                }

                if (ruleLineIndex === -1) {
                    // 没有周次和节次规则，非有效排课数据
                    return;
                }

                const ruleLine = lines[ruleLineIndex];

                // 1. 解析周次
                const weeks = parseWeeks(ruleLine);
                if (weeks.length === 0) return;

                // 2. 解析节次
                let startSection = rowDefaultStartSection;
                let endSection = rowDefaultEndSection;
                const secMatch = ruleLine.match(/\[(\d{1,2})-(\d{1,2})节?\]/);
                if (secMatch) {
                    startSection = parseInt(secMatch[1], 10);
                    endSection = parseInt(secMatch[2], 10);
                } else {
                    const singleSecMatch = ruleLine.match(/\[(\d{1,2})节?\]/);
                    if (singleSecMatch) {
                        startSection = parseInt(singleSecMatch[1], 10);
                        endSection = parseInt(singleSecMatch[1], 10);
                    }
                }

                // 3. 解析课程名称（位于规则行前面的第一行）
                let courseName = "";
                if (ruleLineIndex >= 1) {
                    courseName = lines[0];
                }

                // 4. 解析任课教师（若规则行前有两行，第二行通常是教师）
                let teacher = "";
                if (ruleLineIndex >= 2) {
                    teacher = lines[1];
                }

                // 5. 解析教室位置（位于规则行紧随其后的下一行）
                let position = "";
                if (lines.length > ruleLineIndex + 1) {
                    position = lines[ruleLineIndex + 1];
                }

                if (courseName) {
                    parsedCourses.push({
                        name: courseName,
                        teacher: teacher,
                        position: position,
                        day: day,
                        startSection: startSection,
                        endSection: endSection,
                        weeks: weeks,
                        isCustomTime: false
                    });
                }
            });
        });
    }

    console.log("[时荒课表] 成功解析课程总条数:", parsedCourses.length);

    if (parsedCourses.length === 0) {
        await window.shiguangBridgePromise.showAlert(
            "解析未发现课程",
            "未能从当前表格解析出有效课程数据，请确认是否处于【学期理论课表】页面且课表已正常显示。",
            "好的"
        );
        return;
    }

    // 统计不同课程数量
    const uniqueCourseNames = new Set(parsedCourses.map(c => c.name));

    // 弹窗提示用户确认
    const confirmImport = await window.shiguangBridgePromise.showAlert(
        "课表解析成功",
        `成功抓取到 ${uniqueCourseNames.size} 门课程，共计 ${parsedCourses.length} 个上课排课段。\n\n点击“确定”将自动导入到您的时荒课表中。`,
        "立即导入"
    );

    if (!confirmImport) {
        window.shiguangBridge.showToast("已取消导入操作");
        return;
    }

    // 3. 导入标准作息节次时间
    const defaultTimeSlots = [
        { number: 1, startTime: "08:30", endTime: "09:15" },
        { number: 2, startTime: "09:25", endTime: "10:10" },
        { number: 3, startTime: "10:30", endTime: "11:15" },
        { number: 4, startTime: "11:25", endTime: "12:10" },
        { number: 5, startTime: "14:00", endTime: "14:45" },
        { number: 6, startTime: "14:55", endTime: "15:40" },
        { number: 7, startTime: "16:00", endTime: "16:45" },
        { number: 8, startTime: "16:55", endTime: "17:40" },
        { number: 9, startTime: "19:00", endTime: "19:45" },
        { number: 10, startTime: "19:55", endTime: "20:40" },
        { number: 11, startTime: "20:50", endTime: "21:35" },
        { number: 12, startTime: "21:45", endTime: "22:30" }
    ];

    try {
        // 保存学期周数配置（默认20周）
        await window.shiguangBridgePromise.saveCourseConfig(JSON.stringify({
            semesterTotalWeeks: 20,
            defaultClassDuration: 45,
            defaultBreakDuration: 10,
            firstDayOfWeek: 1
        }));

        // 保存默认作息时间表
        await window.shiguangBridgePromise.savePresetTimeSlots(JSON.stringify(defaultTimeSlots));

        // 保存课程数据
        const saveResult = await window.shiguangBridgePromise.saveImportedCourses(JSON.stringify(parsedCourses));

        if (saveResult === true) {
            window.shiguangBridge.showToast("广州职业技术大学课表导入成功！");
            window.shiguangBridge.notifyTaskCompletion();
        } else {
            window.shiguangBridge.showToast("课程数据保存失败，请重试。");
        }
    } catch (err) {
        console.error("[时荒课表] 保存数据异常:", err);
        window.shiguangBridge.showToast("导入出错: " + err.message);
    }
})();

