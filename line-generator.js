(async function () {
  const svg = d3.select("#viz");
  const W = 1100,
    H = 760;

  // Layout
  const cx = 560,
    cy = 365;
  const rInner = 210;
  const rOuter = 315;
  const ringPad = 16;

  // Brush timeline area (bottom)
  const brushY = 675;
  const brushX0 = 160,
    brushX1 = 940;
  const brushH = 46;

  // State
  let focused = null; // series name
  let showFeathers = true;
  let showAnomalies = true;
  let zoomRange = null; // [i0,i1] inclusive indices; null => all
  let morphT = 0; // 0..1 during morph animation (per redraw)

  // Load data
  const data = await d3.json("data.json");
  d3.select("#title").text(data.meta.title);
  d3.select("#subtitle").text(data.meta.subtitle);

  const monthsAll = data.months.slice();
  const seriesAll = data.series.map((s) => ({
    ...s,
    values: s.values.slice(),
    distribution: s.distribution.slice(),
  }));

  // Tooltip
  const tip = d3
    .select("body")
    .append("div")
    .attr("class", "tooltip")
    .style("opacity", 0);
  function showTip(html, x, y) {
    tip
      .html(html)
      .style("left", `${x}px`)
      .style("top", `${y}px`)
      .transition()
      .duration(90)
      .style("opacity", 1);
  }
  function hideTip() {
    tip.transition().duration(120).style("opacity", 0);
  }

  // defs
  const defs = svg.append("defs");

  // Glow filter
  const glow = defs
    .append("filter")
    .attr("id", "glow")
    .attr("x", "-50%")
    .attr("y", "-50%")
    .attr("width", "200%")
    .attr("height", "200%");
  glow
    .append("feGaussianBlur")
    .attr("stdDeviation", 3)
    .attr("result", "coloredBlur");
  const merge = glow.append("feMerge");
  merge.append("feMergeNode").attr("in", "coloredBlur");
  merge.append("feMergeNode").attr("in", "SourceGraphic");

  // Grain
  const noise = defs.append("filter").attr("id", "noise");
  noise
    .append("feTurbulence")
    .attr("type", "fractalNoise")
    .attr("baseFrequency", 0.9)
    .attr("numOctaves", 2)
    .attr("stitchTiles", "stitch")
    .attr("result", "n");
  noise
    .append("feColorMatrix")
    .attr("type", "matrix")
    .attr("values", "0 0 0 0 0.7  0 0 0 0 0.7  0 0 0 0 0.8  0 0 0 0.06 0");

  // Background grain layer
  svg
    .append("rect")
    .attr("x", 0)
    .attr("y", 0)
    .attr("width", W)
    .attr("height", H)
    .attr("fill", "transparent")
    .attr("filter", "url(#noise)");

  // Root group
  const root = svg.append("g");

  // Owl silhouette path
  const owlPathD = `M ${cx} ${cy - 220}
     C ${cx - 160} ${cy - 230}, ${cx - 280} ${cy - 75}, ${cx - 225} ${cy + 95}
     C ${cx - 200} ${cy + 175}, ${cx - 140} ${cy + 225}, ${cx - 62} ${cy + 252}
     C ${cx - 25} ${cy + 265}, ${cx - 8} ${cy + 285}, ${cx} ${cy + 300}
     C ${cx + 8} ${cy + 285}, ${cx + 25} ${cy + 265}, ${cx + 62} ${cy + 252}
     C ${cx + 140} ${cy + 225}, ${cx + 200} ${cy + 175}, ${cx + 225} ${cy + 95}
     C ${cx + 280} ${cy - 75}, ${cx + 160} ${cy - 230}, ${cx} ${cy - 220} Z`;

  root
    .append("path")
    .attr("d", owlPathD)
    .attr("fill", "rgba(255,255,255,0.03)")
    .attr("stroke", "rgba(255,255,255,0.10)")
    .attr("stroke-width", 1.2);

  // Containers
  const ringG = root.append("g").attr("transform", `translate(${cx},${cy})`);
  const feathersG = root.append("g").attr("class", "feathers");
  const anomaliesG = root.append("g").attr("class", "anomalies");
  const eyesG = root.append("g").attr("class", "eyes");
  const brushG = root.append("g").attr("class", "brush");

  // Hover dot for nearest point
  const hoverDot = svg
    .append("circle")
    .attr("r", 5)
    .attr("opacity", 0)
    .attr("stroke", "rgba(255,255,255,0.75)")
    .attr("stroke-width", 1.2)
    .attr("filter", "url(#glow)");

  // Capture layer for Delaunay tooltip
  const capture = svg
    .append("rect")
    .attr("x", 0)
    .attr("y", 0)
    .attr("width", W)
    .attr("height", H)
    .attr("fill", "transparent");

  // Legend
  const legend = d3.select("#legend");

  // Buttons
  d3.select("#toggleFeathersBtn").on("click", () => {
    showFeathers = !showFeathers;
    feathersG
      .transition()
      .duration(200)
      .style("opacity", showFeathers ? 1 : 0);
  });
  d3.select("#toggleAnomaliesBtn").on("click", () => {
    showAnomalies = !showAnomalies;
    anomaliesG
      .transition()
      .duration(200)
      .style("opacity", showAnomalies ? 1 : 0);
  });
  d3.select("#resetBtn").on("click", () => {
    focused = null;
    zoomRange = null;
    setBrushToAll();
    render(true);
  });

  // ----------- Helpers -----------
  const fmt = d3.format(",");
  const money = (n) => `$${fmt(n)}`;

  function getZoomedMonths() {
    if (!zoomRange)
      return { months: monthsAll, i0: 0, i1: monthsAll.length - 1 };
    const i0 = Math.max(0, Math.min(monthsAll.length - 1, zoomRange[0]));
    const i1 = Math.max(0, Math.min(monthsAll.length - 1, zoomRange[1]));
    const a0 = Math.min(i0, i1);
    const a1 = Math.max(i0, i1);
    return { months: monthsAll.slice(a0, a1 + 1), i0: a0, i1: a1 };
  }

  function globalMinMax() {
    const all = seriesAll.flatMap((s) => s.values);
    return [d3.min(all), d3.max(all)];
  }

  function detectAnomalies(values, z = 1.1) {
    // Outliers by z-score + local maxima (lightweight but effective)
    const mean = d3.mean(values);
    const sd = d3.deviation(values) || 1;

    const out = [];
    for (let i = 1; i < values.length - 1; i++) {
      const v = values[i];
      const zscore = (v - mean) / sd;
      const isLocalMax = v > values[i - 1] && v >= values[i + 1];
      const isOutlier = zscore >= z;

      if (isLocalMax && isOutlier) {
        out.push({ i, v, z: zscore });
      }
    }
    return out;
  }

  function buildFeatherHeatmapDistributions() {
    // Combine distributions across all series (mean), plus a "spread" channel (stddev)
    const bins = seriesAll[0]?.distribution?.length || 10;
    const meanDist = d3
      .range(bins)
      .map((i) => d3.mean(seriesAll.map((s) => s.distribution[i])));
    const sdDist = d3
      .range(bins)
      .map((i) => d3.deviation(seriesAll.map((s) => s.distribution[i])) || 0);

    const meanMax = d3.max(meanDist) || 1;
    const sdMax = d3.max(sdDist) || 1;

    return {
      meanDist,
      sdDist,
      meanMax,
      sdMax,
    };
  }

  function featherPath(x0, y0, w, h, bump, pinch) {
    // bump influences height (analytics); pinch influences curvature (variance)
    const b = bump; // 0..1
    const p = pinch; // 0..1
    const lift = h * (0.4 + 1.25 * b);
    const curl = w * (0.05 + 0.18 * p);

    return `M ${x0} ${y0}
            C ${x0 + w * 0.2} ${y0 - lift}, ${x0 + w * 0.45} ${
      y0 - lift * 0.55
    }, ${x0 + w * 0.55} ${y0 - lift * 0.25}
            C ${x0 + w * 0.72} ${y0 + h * 0.08 + curl}, ${x0 + w * 0.88} ${
      y0 + h * 0.1
    }, ${x0 + w} ${y0}
            C ${x0 + w * 0.7} ${y0 + h * 0.24}, ${x0 + w * 0.34} ${
      y0 + h * 0.24 + curl
    }, ${x0} ${y0} Z`;
  }

  // ----------- Gradients per series -----------
  seriesAll.forEach((s, idx) => {
    const gradId = `grad-${idx}`;
    const grad = defs
      .append("linearGradient")
      .attr("id", gradId)
      .attr("x1", "0%")
      .attr("y1", "0%")
      .attr("x2", "100%")
      .attr("y2", "100%");
    grad
      .append("stop")
      .attr("offset", "0%")
      .attr("stop-color", s.color)
      .attr("stop-opacity", 0.92);
    grad
      .append("stop")
      .attr("offset", "100%")
      .attr("stop-color", "#ffffff")
      .attr("stop-opacity", 0.24);
    s._gradId = gradId;
  });

  //   // ----------- Brush (time zoom) -----------
  //   const xBrush = d3
  //     .scaleLinear()
  //     .domain([0, monthsAll.length - 1])
  //     .range([brushX0, brushX1]);

  //   // Timeline base
  //   brushG
  //     .append("rect")
  //     .attr("x", brushX0)
  //     .attr("y", brushY - brushH / 2)
  //     .attr("width", brushX1 - brushX0)
  //     .attr("height", brushH)
  //     .attr("rx", 14)
  //     .attr("fill", "rgba(255,255,255,0.04)")
  //     .attr("stroke", "rgba(255,255,255,0.12)");

  //   brushG
  //     .append("text")
  //     .attr("x", brushX0)
  //     .attr("y", brushY - brushH / 2 - 12)
  //     .attr("fill", "rgba(238,243,255,0.55)")
  //     .attr("font-size", 11)
  //     .text("TIME ZOOM (drag)");

  //   // Month tick labels (small)
  //   brushG
  //     .append("g")
  //     .selectAll("text")
  //     .data(monthsAll)
  //     .join("text")
  //     .attr("x", (_, i) => xBrush(i))
  //     .attr("y", brushY + brushH / 2 + 16)
  //     .attr("text-anchor", "middle")
  //     .attr("fill", "rgba(238,243,255,0.30)")
  //     .attr("font-size", 9)
  //     .text((d) => d.slice(5));

  //   const brush = d3
  //     .brushX()
  //     .extent([
  //       [brushX0, brushY - brushH / 2],
  //       [brushX1, brushY + brushH / 2],
  //     ])
  //     .on("brush end", (event) => {
  //       if (!event.selection) return;
  //       const [sx0, sx1] = event.selection;
  //       const i0 = Math.round(xBrush.invert(sx0));
  //       const i1 = Math.round(xBrush.invert(sx1));
  //       zoomRange = [i0, i1];
  //       render(false);
  //     });

  //   const brushCallG = brushG.append("g").attr("class", "brush-call").call(brush);

  //   function setBrushToAll() {
  //     brushCallG.call(brush.move, [xBrush(0), xBrush(monthsAll.length - 1)]);
  //   }
  //   setBrushToAll();

  // ----------- Render pipeline -----------
  function render(animateIntro) {
    const { months, i0, i1 } = getZoomedMonths();
    const monthCount = months.length;

    // Scales for current zoom
    const angle = d3
      .scaleLinear()
      .domain([0, monthCount - 1])
      .range([-Math.PI * 0.92, Math.PI * 0.92]);

    const [vMin, vMax] = globalMinMax();
    const r = d3.scaleLinear().domain([vMin, vMax]).range([rInner, rOuter]);

    // Radial generators (paths)
    const radialLine = d3
      .lineRadial()
      .angle((d, i) => angle(i))
      .radius((d) => r(d))
      .curve(d3.curveCatmullRomClosed.alpha(0.7));

    const radialArea = d3
      .areaRadial()
      .angle((d, i) => angle(i))
      .innerRadius(rInner)
      .outerRadius((d) => r(d))
      .curve(d3.curveCatmullRomClosed.alpha(0.7));

    // Clear & rebuild ring layers cleanly (stable)
    ringG.selectAll("*").remove();

    // Axis circles
    const tickVals = d3.ticks(vMin, vMax, 5);
    ringG
      .append("g")
      .attr("opacity", 0.85)
      .selectAll("circle")
      .data(tickVals)
      .join("circle")
      .attr("r", (d) => r(d))
      .attr("fill", "none")
      .attr("stroke", "rgba(255,255,255,0.08)")
      .attr("stroke-dasharray", "3 6");

    // Month spokes
    ringG
      .append("g")
      .attr("opacity", 0.65)
      .selectAll("line")
      .data(months)
      .join("line")
      .attr("x1", 0)
      .attr("y1", 0)
      .attr("x2", (d, i) => Math.cos(angle(i) - Math.PI / 2) * (rOuter + 12))
      .attr("y2", (d, i) => Math.sin(angle(i) - Math.PI / 2) * (rOuter + 12))
      .attr("stroke", "rgba(255,255,255,0.06)");

    // Month labels
    ringG
      .append("g")
      .selectAll("text")
      .data(months)
      .join("text")
      .attr("x", (d, i) => Math.cos(angle(i) - Math.PI / 2) * (rOuter + 30))
      .attr("y", (d, i) => Math.sin(angle(i) - Math.PI / 2) * (rOuter + 30))
      .attr("text-anchor", "middle")
      .attr("dominant-baseline", "middle")
      .attr("fill", "rgba(238,243,255,0.35)")
      .attr("font-size", 10)
      .text((d) => d.slice(5));

    // Determine focus series & morph targets
    const focusSeries = focused
      ? seriesAll.find((s) => s.name === focused)
      : null;

    // For morphing:
    // - If focused: other series values smoothly interpolate toward focusSeries values (in current zoom)
    // - Focus series stays exact
    function morphedValues(s, t) {
      const v = s.values.slice(i0, i1 + 1);
      if (!focusSeries || s.name === focusSeries.name) return v;

      const fv = focusSeries.values.slice(i0, i1 + 1);
      // Interpolate element-wise (same length because zoomed)
      return v.map((x, idx) => x + (fv[idx] - x) * t);
    }

    // Layers
    const layers = ringG.append("g");

    // Create a stable group per series
    const seriesG = layers
      .selectAll(".series")
      .data(seriesAll, (d) => d.name)
      .join("g")
      .attr("class", "series")
      .style("cursor", "pointer")
      .on("click", (_, s) => {
        focused = focused === s.name ? null : s.name;
        render(false);
      });

    // Base opacity rules (still helps even with morph)
    function seriesOpacity(s) {
      if (!focused) return 1;
      return s.name === focused ? 1 : 0.55;
    }

    // Draw area + line using current morphT; we animate morphT on focus changes
    const prevMorphT = morphT;
    const targetMorphT = focused ? 1 : 0;
    morphT = targetMorphT;

    // We animate by transitioning a dummy value and re-rendering paths each tick
    const morphNode = { t: prevMorphT };
    const morphDur = 700;

    function drawAt(t) {
      // AREA
      seriesG
        .selectAll("path.area")
        .data((d) => [d])
        .join("path")
        .attr("class", "area")
        .attr("d", (d) => radialArea(morphedValues(d, t)))
        .attr("fill", (d) => d.color)
        .attr("opacity", (d) => 0.1 * seriesOpacity(d));

      // LINE
      seriesG
        .selectAll("path.line")
        .data((d) => [d])
        .join("path")
        .attr("class", "line")
        .attr("d", (d) => radialLine(morphedValues(d, t)))
        .attr("fill", "none")
        .attr("stroke", (d) => `url(#${d._gradId})`)
        .attr("stroke-width", (d) =>
          focused && d.name === focused ? 2.6 : 2.1
        )
        .attr("filter", "url(#glow)")
        .attr("opacity", (d) => 0.92 * seriesOpacity(d));
    }

    // Initial draw
    drawAt(prevMorphT);

    // Animate intro draw effect (only first render)
    if (animateIntro) {
      seriesG.selectAll("path.line").each(function () {
        const p = d3.select(this);
        const len = this.getTotalLength();
        p.attr("stroke-dasharray", `${len} ${len}`)
          .attr("stroke-dashoffset", len)
          .transition()
          .duration(1200)
          .ease(d3.easeCubicOut)
          .attr("stroke-dashoffset", 0)
          .on("end", () =>
            p.attr("stroke-dasharray", null).attr("stroke-dashoffset", null)
          );
      });
    }

    // Morph transition (focus on/off)
    d3.select(morphNode)
      .interrupt()
      .transition()
      .duration(morphDur)
      .ease(d3.easeCubicInOut)
      .tween("morph", () => {
        const it = d3.interpolateNumber(prevMorphT, targetMorphT);
        return (tt) => {
          morphNode.t = it(tt);
          drawAt(morphNode.t);
          // Keep anomalies and tooltips consistent during morph by rebuilding point cloud lightly
          // (We do this only at the end to keep it fast.)
        };
      })
      .on("end", () => {
        rebuildTooling(); // Delaunay, anomalies, eyes after morph completes
      });

    // If no morph needed, still rebuild tooling
    if (prevMorphT === targetMorphT) {
      rebuildTooling();
    }

    // ----------- Tooling: Delaunay tooltip + anomalies + eyes + feathers -----------
    function rebuildTooling() {
      // 1) Delaunay nearest point tooltip uses current morph state (target state)
      const points = [];
      const pointMeta = [];

      seriesAll.forEach((s) => {
        const vals = morphedValues(s, targetMorphT);
        vals.forEach((v, idx) => {
          const a = angle(idx) - Math.PI / 2;
          const rr = r(v);
          const x = cx + Math.cos(a) * rr;
          const y = cy + Math.sin(a) * rr;
          points.push([x, y]);
          pointMeta.push({
            series: s.name,
            month: months[idx],
            value: v,
            color: s.color,
            kpis: s.kpis,
          });
        });
      });

      const delaunay = d3.Delaunay.from(
        points,
        (d) => d[0],
        (d) => d[1]
      );

      capture
        .on("mousemove", (event) => {
          const [mx, my] = d3.pointer(event, svg.node());
          const idx = delaunay.find(mx, my);
          const m = pointMeta[idx];

          if (focused && m.series !== focused) return;

          showTip(
            `<div class="t1"><span class="chip">RADAR</span>${m.series} • <b>${
              m.month
            }</b></div>
           <div class="t2" style="color:${m.color}"><b>${Math.round(
              m.value
            )}</b> intensity</div>
           <div class="t3">Risk: <b>${m.kpis.riskScore}</b> • Loss: <b>${money(
              m.kpis.lossUSD
            )}</b> • Vol: <b>${fmt(m.kpis.volume)}</b></div>`,
            event.clientX,
            event.clientY
          );

          hoverDot
            .attr("cx", points[idx][0])
            .attr("cy", points[idx][1])
            .attr("opacity", 1)
            .attr("fill", m.color);
        })
        .on("mouseleave", () => {
          hideTip();
          hoverDot.attr("opacity", 0);
        });

      // 2) Anomaly spikes
      anomaliesG.selectAll("*").remove();
      anomaliesG.style("opacity", showAnomalies ? 1 : 0);

      if (showAnomalies) {
        const spikeLen = 18;
        const labelOffset = 12;

        const anomalyData = [];
        seriesAll.forEach((s) => {
          const vals = morphedValues(s, targetMorphT);
          // detect anomalies within zoomed window
          const hits = detectAnomalies(vals, 1.05);
          hits.forEach((h) => {
            anomalyData.push({
              series: s,
              idx: h.i,
              value: h.v,
              z: h.z,
              month: months[h.i],
            });
          });
        });

        // Avoid clutter: take top anomalies by z per series, max 2
        const grouped = d3.group(anomalyData, (d) => d.series.name);
        const curated = [];
        for (const [k, arr] of grouped) {
          arr.sort((a, b) => d3.descending(a.z, b.z));
          curated.push(...arr.slice(0, 2));
        }

        const aG = anomaliesG.append("g");

        aG.selectAll("line.spike")
          .data(curated)
          .join("line")
          .attr("class", "spike")
          .attr(
            "x1",
            (d) => cx + Math.cos(angle(d.idx) - Math.PI / 2) * r(d.value)
          )
          .attr(
            "y1",
            (d) => cy + Math.sin(angle(d.idx) - Math.PI / 2) * r(d.value)
          )
          .attr(
            "x2",
            (d) =>
              cx +
              Math.cos(angle(d.idx) - Math.PI / 2) * (r(d.value) + spikeLen)
          )
          .attr(
            "y2",
            (d) =>
              cy +
              Math.sin(angle(d.idx) - Math.PI / 2) * (r(d.value) + spikeLen)
          )
          .attr("stroke", (d) => d.series.color)
          .attr("stroke-width", 2.2)
          .attr("filter", "url(#glow)")
          .attr(
            "opacity",
            focused ? (d) => (d.series.name === focused ? 1 : 0.15) : 0.95
          );

        aG.selectAll("circle.node")
          .data(curated)
          .join("circle")
          .attr("class", "node")
          .attr(
            "cx",
            (d) =>
              cx +
              Math.cos(angle(d.idx) - Math.PI / 2) * (r(d.value) + spikeLen)
          )
          .attr(
            "cy",
            (d) =>
              cy +
              Math.sin(angle(d.idx) - Math.PI / 2) * (r(d.value) + spikeLen)
          )
          .attr("r", 4.5)
          .attr("fill", (d) => d.series.color)
          .attr("stroke", "rgba(255,255,255,0.75)")
          .attr("stroke-width", 1)
          .attr("filter", "url(#glow)")
          .style("cursor", "help")
          .attr(
            "opacity",
            focused ? (d) => (d.series.name === focused ? 1 : 0.1) : 0.95
          )
          .on("mousemove", (event, d) => {
            showTip(
              `<div class="t1"><span class="chip">ANOMALY</span><b>${
                d.series.name
              }</b> • ${d.month}</div>
               <div class="t2" style="color:${
                 d.series.color
               }">Peak intensity: <b>${Math.round(d.value)}</b></div>
               <div class="t3">Z-score: <b>${d.z.toFixed(
                 2
               )}</b> • Auto-detected local max outlier</div>`,
              event.clientX,
              event.clientY
            );
          })
          .on("mouseleave", hideTip);

        aG.selectAll("text.label")
          .data(curated)
          .join("text")
          .attr("class", "label")
          .attr(
            "x",
            (d) =>
              cx +
              Math.cos(angle(d.idx) - Math.PI / 2) *
                (r(d.value) + spikeLen + labelOffset)
          )
          .attr(
            "y",
            (d) =>
              cy +
              Math.sin(angle(d.idx) - Math.PI / 2) *
                (r(d.value) + spikeLen + labelOffset)
          )
          .attr("fill", "rgba(238,243,255,0.55)")
          .attr("font-size", 10)
          .attr("text-anchor", "middle")
          .text((d) => d.month.slice(5))
          .attr(
            "opacity",
            focused ? (d) => (d.series.name === focused ? 1 : 0.1) : 0.8
          );
      }

      // 3) Eyes (KPI donut gauges)
      eyesG.selectAll("*").remove();
      const byRisk = [...seriesAll].sort((a, b) =>
        d3.descending(a.kpis.riskScore, b.kpis.riskScore)
      );
      const byLoss = [...seriesAll].sort((a, b) =>
        d3.descending(a.kpis.lossUSD, b.kpis.lossUSD)
      );
      const leftSeries = focused
        ? seriesAll.find((s) => s.name === focused)
        : byRisk[0];
      const rightSeries = focused
        ? seriesAll.find((s) => s.name === focused)
        : byLoss[0];

      drawEye(
        { x: cx - 120, y: cy - 28, r0: 34, r1: 56 },
        leftSeries,
        focused ? "FOCUS" : "RISK"
      );
      drawEye(
        { x: cx + 120, y: cy - 28, r0: 34, r1: 56 },
        rightSeries,
        focused ? "FOCUS" : "LOSS"
      );

      // Beak
      root.selectAll("path.beak").remove();
      root
        .append("path")
        .attr("class", "beak")
        .attr(
          "d",
          `M ${cx} ${cy + 34}
                    C ${cx - 18} ${cy + 58}, ${cx - 12} ${cy + 85}, ${cx} ${
            cy + 100
          }
                    C ${cx + 12} ${cy + 85}, ${cx + 18} ${cy + 58}, ${cx} ${
            cy + 34
          } Z`
        )
        .attr("fill", "rgba(255,255,255,0.10)")
        .attr("stroke", "rgba(255,255,255,0.14)");

      // 4) Feather heatmap (true analytics-driven)
      renderFeathersHeatmap();
    }

    function drawEye(eye, series, label) {
      const pct = (series.kpis.riskScore || 0) / 100;
      const startA = -Math.PI * 0.8;
      const endA = startA + Math.PI * 1.6 * pct;

      const eyeArc = d3
        .arc()
        .innerRadius(eye.r0)
        .outerRadius(eye.r1)
        .startAngle(startA);

      const eg = eyesG
        .append("g")
        .attr("transform", `translate(${eye.x},${eye.y})`);

      eg.append("circle")
        .attr("r", eye.r1 + 10)
        .attr("fill", "rgba(255,255,255,0.03)")
        .attr("stroke", "rgba(255,255,255,0.10)");

      eg.append("path")
        .datum({ endAngle: startA + Math.PI * 1.6 })
        .attr("d", (d) => eyeArc.endAngle(d.endAngle)(d))
        .attr("fill", "rgba(255,255,255,0.06)");

      const prog = eg
        .append("path")
        .datum({ endAngle: endA })
        .attr("d", (d) => eyeArc.endAngle(startA)(d))
        .attr("fill", series.color)
        .attr("filter", "url(#glow)");

      prog
        .transition()
        .duration(800)
        .ease(d3.easeCubicOut)
        .attrTween("d", function (d) {
          const i = d3.interpolateNumber(startA, d.endAngle);
          return (t) => eyeArc.endAngle(i(t))(d);
        });

      eg.append("circle")
        .attr("r", 13)
        .attr("fill", "rgba(255,255,255,0.12)")
        .attr("stroke", "rgba(255,255,255,0.18)");

      eg.append("text")
        .attr("y", 5)
        .attr("text-anchor", "middle")
        .attr("fill", "rgba(238,243,255,0.92)")
        .attr("font-size", 12)
        .attr("font-weight", 700)
        .text(series.kpis.riskScore);

      eg.append("text")
        .attr("y", eye.r1 + 26)
        .attr("text-anchor", "middle")
        .attr("fill", "rgba(238,243,255,0.55)")
        .attr("font-size", 11)
        .text(label);

      // Hover tooltip
      eg.append("circle")
        .attr("r", eye.r1 + 12)
        .attr("fill", "transparent")
        .style("cursor", "help")
        .on("mousemove", (event) => {
          showTip(
            `<div class="t1"><span class="chip">EYE KPI</span>${label}</div>
             <div class="t2" style="color:${series.color}"><b>${
              series.name
            }</b></div>
             <div class="t3">Risk: <b>${
               series.kpis.riskScore
             }</b> • Loss: <b>${money(
              series.kpis.lossUSD
            )}</b> • Volume: <b>${fmt(series.kpis.volume)}</b></div>`,
            event.clientX,
            event.clientY
          );
        })
        .on("mouseleave", hideTip);
    }

    function renderFeathersHeatmap() {
      feathersG.selectAll("*").remove();
      feathersG.style("opacity", showFeathers ? 1 : 0);

      if (!showFeathers) return;

      const { meanDist, sdDist, meanMax, sdMax } =
        buildFeatherHeatmapDistributions();

      // Map mean density and variance to feather geometry + color
      const cMean = d3
        .scaleSequential(d3.interpolateTurbo)
        .domain([0, meanMax]);
      const cVar = d3.scaleSequential(d3.interpolateViridis).domain([0, sdMax]);

      // Two feather fields: left & right
      const rows = 6,
        cols = 5;
      const w = 78,
        h = 38;
      const gapX = 12,
        gapY = 12;
      const leftStartX = cx - 270;
      const rightStartX = cx + 36;
      const startY = cy + 112;

      // Build feather cells, each driven by distributions (cycling bins)
      const featherData = [];
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const k = (r * cols + c) % meanDist.length;
          const density = meanDist[k];
          const variance = sdDist[k];

          featherData.push({
            side: "L",
            x: leftStartX + c * (w + gapX),
            y: startY + r * (h + gapY),
            density,
            variance,
          });
          featherData.push({
            side: "R",
            x: rightStartX + c * (w + gapX),
            y: startY + r * (h + gapY),
            density,
            variance,
          });
        }
      }

      const feather = feathersG
        .append("g")
        .selectAll("path")
        .data(featherData)
        .join("path")
        .attr("d", (d) => {
          const bump = d.density / meanMax; // 0..1
          const pinch = sdMax === 0 ? 0 : d.variance / sdMax;
          return featherPath(d.x, d.y, w, h, bump, pinch);
        })
        .attr("fill", (d) => cMean(d.density))
        .attr("fill-opacity", 0.12)
        .attr("stroke", (d) => cVar(d.variance))
        .attr("stroke-opacity", 0.24)
        .attr("stroke-width", 1.1)
        .attr("opacity", 0)
        .transition()
        .delay((d, i) => i * 8)
        .duration(420)
        .ease(d3.easeCubicOut)
        .attr("opacity", 1);

      // Hover interaction
      feathersG
        .selectAll("path")
        .style("cursor", "help")
        .on("mousemove", (event, d) => {
          const bump = d.density / meanMax;
          const pinch = sdMax === 0 ? 0 : d.variance / sdMax;
          showTip(
            `<div class="t1"><span class="chip">HEATMAP</span>Feather analytics texture</div>
             <div class="t2"><b>Density</b>: ${d.density.toFixed(
               3
             )} • <b>Variance</b>: ${d.variance.toFixed(3)}</div>
             <div class="t3">Geometry: bump <b>${bump.toFixed(
               2
             )}</b> • pinch <b>${pinch.toFixed(
              2
            )}</b> (from combined distributions)</div>`,
            event.clientX,
            event.clientY
          );
          d3.select(event.currentTarget)
            .attr("filter", "url(#glow)")
            .attr("fill-opacity", 0.2)
            .attr("stroke-opacity", 0.38);
        })
        .on("mouseleave", (event) => {
          hideTip();
          d3.select(event.currentTarget)
            .attr("filter", null)
            .attr("fill-opacity", 0.12)
            .attr("stroke-opacity", 0.24);
        });
    }

    // ----------- Legend (focus + morph) -----------
    legend.selectAll(".item").remove();

    legend
      .selectAll(".item")
      .data(seriesAll)
      .join("div")
      .attr("class", "item")
      .classed("dim", (d) => focused && d.name !== focused)
      .on("click", (_, s) => {
        focused = focused === s.name ? null : s.name;
        render(false);
      })
      .on("mousemove", (event, s) => {
        showTip(
          `<div class="t1"><span class="chip">LEGEND</span>Series</div>
           <div class="t2" style="color:${s.color}"><b>${s.name}</b></div>
           <div class="t3">Risk: <b>${s.kpis.riskScore}</b> • Loss: <b>${money(
            s.kpis.lossUSD
          )}</b> • Vol: <b>${fmt(s.kpis.volume)}</b></div>`,
          event.clientX,
          event.clientY
        );
      })
      .on("mouseleave", hideTip)
      .each(function (s) {
        const item = d3.select(this);
        item.append("div").attr("class", "dot").style("background", s.color);
        const text = item.append("div");
        text.append("div").attr("class", "name").text(s.name);
        text
          .append("div")
          .attr("class", "meta")
          .text(`Risk ${s.kpis.riskScore} • ${money(s.kpis.lossUSD)}`);
      });
  }

  // Kickoff render
  render(true);
})();

// /* ============================================================
//    1. SELECT CANVAS
// ============================================================ */
// const canvas = d3.select(".canva");

// /* ============================================================
//    2. CREATE SVG
// ============================================================ */
// const svg = canvas.append("svg").attr("width", 600).attr("height", 600);

// /* ============================================================
//    3. DATA
// ============================================================ */
// var data = [
//   { x: 10, y: 10 },
//   { x: 15, y: 20 },
//   { x: 20, y: 40 },
//   { x: 25, y: 7 },
//   { x: 30, y: 10 },
// ];

// /* ============================================================
//    4. MARGINS & GRAPH DIMENSIONS
// ============================================================ */
// const margin = { top: 20, right: 20, bottom: 70, left: 70 };
// const graphWidth = 600 - margin.left - margin.right;
// const graphHeight = 600 - margin.top - margin.bottom;

// //const barBaseGap = 6; // space between bars and x-axis

// /* ============================================================
//    5. GRAPH GROUP
// ============================================================ */
// const area = svg
//   .append("g")
//   .attr("width", graphWidth)
//   .attr("height", graphHeight)
//   .attr("transform", `translate(${margin.left}, ${margin.top})`);

// var linearGen = d3
//   .line()
//   .x((d, i) => d.x * 6)
//   .y((d, i) => d.y * 5);

// area
//   .append("path")
//   .attr("fill", "none")
//   .attr("stroke", "black")
//   .attr("d", linearGen(data));
