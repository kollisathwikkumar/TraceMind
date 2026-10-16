(() => {
  const motionOff = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const hero = document.querySelector('.hero');
  const nav = document.querySelector('.top-nav');

  function drawArrowField(canvas, { interactive = false } = {}) {
    const context = canvas.getContext('2d');
    if (!context) return;
    // Tighter grid, keeping the glyph size steady so the field feels rich, not noisy.
    const density = canvas.classList.contains('band-field') ? 21 : 18;
    let width = 0;
    let height = 0;
    let raf = 0;
    let pointer = { x: -1000, y: -1000, active: false };
    let ripple = null;
    let lastInput = 0;
    let introPlayed = false;

    function resize() {
      const bounds = canvas.getBoundingClientRect();
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      width = bounds.width;
      height = bounds.height;
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      if (interactive && !motionOff && !introPlayed) {
        ripple = { x: width * 0.5, y: height * 0.42, started: performance.now() };
        introPlayed = true;
      }
      render(performance.now());
    }

    function render(now) {
      if (!context || !width || !height) return;
      context.clearRect(0, 0, width, height);
      const cols = Math.ceil(width / density) + 1;
      const rows = Math.ceil(height / density) + 1;
      const fieldRadius = Math.max(250, Math.min(320, Math.min(width, height) * 0.38));
      const centerY = canvas.classList.contains('band-field') ? height * 0.52 : height * 0.47;
      const maxRipple = Math.max(width, height) * 0.72;
      let rippleAge = Infinity;
      if (ripple && !motionOff) rippleAge = now - ripple.started;
      const rippleProgress = Math.min(1, rippleAge / 1450);
      const rippleRadius = maxRipple * rippleProgress;
      const rippleOpacity = rippleAge < 1450 ? Math.sin(Math.PI * rippleProgress) * 0.72 : 0;

      if (ripple && rippleAge < 1450 && rippleRadius > 2) {
        context.save();
        context.beginPath();
        context.arc(ripple.x, ripple.y, rippleRadius, 0, Math.PI * 2);
        context.strokeStyle = `rgba(255, 255, 255, ${rippleOpacity * 0.34})`;
        context.lineWidth = 1.5;
        context.shadowColor = `rgba(224, 236, 255, ${rippleOpacity * 0.8})`;
        context.shadowBlur = 14;
        context.stroke();
        const echoAge = Math.max(0, rippleAge - 170);
        const echoRadius = maxRipple * Math.min(1, echoAge / 1450);
        if (echoAge > 0) {
          context.beginPath();
          context.arc(ripple.x, ripple.y, echoRadius, 0, Math.PI * 2);
          context.strokeStyle = `rgba(226, 237, 255, ${rippleOpacity * 0.18})`;
          context.lineWidth = 1;
          context.stroke();
        }
        context.restore();
      }

      for (let row = 0; row < rows; row += 1) {
        for (let col = 0; col < cols; col += 1) {
          const x = col * density + (row % 2 ? density * 0.5 : 0);
          const y = row * density;
          const centerDist = Math.hypot((x - width * 0.5) * 0.28, (y - centerY) * 0.9);
          const clear = interactive ? Math.max(0.015, Math.min(1, (centerDist - 140) / 135)) : 1;
          const px = pointer.active ? x - pointer.x : 0;
          const py = pointer.active ? y - pointer.y : 0;
          const dist = Math.hypot(px, py);
          const pointerAge = now - lastInput;
          const pointerFade = pointer.active ? Math.max(0, 1 - pointerAge / 850) : 0;
          const influence =
            pointerFade && dist < fieldRadius ? (1 - dist / fieldRadius) * pointerFade : 0;
          const rippleDist = ripple
            ? Math.abs(Math.hypot(x - ripple.x, y - ripple.y) - rippleRadius)
            : maxRipple;
          const wave =
            ripple && rippleAge < 1450 ? Math.max(0, 1 - rippleDist / 42) * rippleOpacity : 0;
          // Turn each arrow toward the radial direction from the cursor, like the reference field.
          let radialTurn = Math.atan2(py, px) + Math.PI / 4;
          radialTurn = Math.atan2(Math.sin(radialTurn), Math.cos(radialTurn));
          const angle = influence * radialTurn + wave * 0.3;
          const size = density * (0.5 + influence * 0.65 + wave * 0.25);
          const vertical = y / Math.max(height, 1);
          // Preserve a bright signal at the pointer and wavefront, including over the title's quiet zone.
          const alpha = Math.min(
            0.86,
            Math.max((0.18 + vertical * 0.11) * clear, influence * 0.82, wave * 0.9)
          );
          context.save();
          context.translate(x, y);
          context.rotate(angle);
          context.strokeStyle =
            vertical > 0.67
              ? `rgba(41, 80, 177, ${alpha})`
              : `rgba(247, 250, 255, ${alpha + 0.08})`;
          context.lineWidth = Math.max(1, density * 0.055);
          context.lineCap = 'square';
          context.beginPath();
          context.moveTo(-size * 0.38, size * 0.36);
          context.lineTo(size * 0.33, -size * 0.33);
          context.moveTo(-size * 0.32, -size * 0.33);
          context.lineTo(size * 0.33, -size * 0.33);
          context.lineTo(size * 0.33, size * 0.32);
          context.stroke();
          context.restore();
        }
      }
      if ((pointer.active && now - lastInput < 850) || rippleAge < 1450)
        raf = requestAnimationFrame(render);
      else {
        pointer.active = false;
        raf = 0;
      }
    }

    function schedule() {
      if (!raf) raf = requestAnimationFrame(render);
    }

    if (interactive && !motionOff) {
      canvas.parentElement.addEventListener(
        'pointermove',
        (event) => {
          const bounds = canvas.getBoundingClientRect();
          pointer = { x: event.clientX - bounds.left, y: event.clientY - bounds.top, active: true };
          lastInput = performance.now();
          schedule();
        },
        { passive: true }
      );
      canvas.parentElement.addEventListener('pointerleave', () => {
        // Let the arrow field settle rather than snapping back when the pointer exits.
        lastInput = performance.now();
        schedule();
      });
      canvas.parentElement.addEventListener(
        'pointerdown',
        (event) => {
          const bounds = canvas.getBoundingClientRect();
          pointer = {
            x: event.clientX - bounds.left,
            y: event.clientY - bounds.top,
            active: true,
          };
          lastInput = performance.now();
          ripple = {
            x: event.clientX - bounds.left,
            y: event.clientY - bounds.top,
            started: performance.now(),
          };
          schedule();
        },
        { passive: true }
      );
    }
    const observer = new ResizeObserver(resize);
    observer.observe(canvas.parentElement);
    resize();
  }

  document.querySelectorAll('.arrow-field, .band-field').forEach((canvas) => {
    drawArrowField(canvas, { interactive: true });
  });

  if (hero && nav) {
    const updateNav = () =>
      nav.classList.toggle('is-solid', hero.getBoundingClientRect().bottom <= 82);
    window.addEventListener('scroll', updateNav, { passive: true });
    updateNav();
  }

  const roleContent = {
    sre: {
      headline: 'Your first hour should start with evidence, not a blank page.',
      description:
        'Trace alerts across services, test likely causes, and keep the investigation readable for everyone joining the response.',
    },
    platform: {
      headline: 'Understand how one service change reaches the rest of the system.',
      description:
        'Bring dependency context and infrastructure signals into the incident view, so the blast radius is easier to reason about.',
    },
    commander: {
      headline: 'Give the response team one shared picture to work from.',
      description:
        'Keep the timeline, evolving hypotheses, evidence, and next steps together as teammates join and decisions change.',
    },
    lead: {
      headline: 'Make the reasoning behind a recommendation visible.',
      description:
        'See what supports the likely cause, what remains uncertain, and which operational knowledge informed the proposed response.',
    },
  };
  const roleTabs = [...document.querySelectorAll('.role-tab')];
  const roleHeadline = document.getElementById('role-headline');
  const roleDescription = document.getElementById('role-description');
  const roleCopy = document.querySelector('.role-copy');
  function selectRole(tab, focus = false) {
    const copy = roleContent[tab.dataset.role];
    if (!copy || !roleHeadline || !roleDescription) return;
    roleTabs.forEach((item) => {
      const selected = item === tab;
      item.classList.toggle('is-selected', selected);
      item.setAttribute('aria-selected', String(selected));
      item.tabIndex = selected ? 0 : -1;
    });
    if (roleCopy) roleCopy.classList.add('is-changing');
    roleHeadline.textContent = copy.headline;
    roleDescription.textContent = copy.description;
    if (roleCopy) {
      requestAnimationFrame(() =>
        requestAnimationFrame(() => roleCopy.classList.remove('is-changing'))
      );
    }
    if (focus) tab.focus();
  }
  roleTabs.forEach((tab, index) => {
    tab.addEventListener('click', () => selectRole(tab));
    tab.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? roleTabs.length - 1
            : (index + (event.key === 'ArrowRight' ? 1 : roleTabs.length - 1)) % roleTabs.length;
      selectRole(roleTabs[next], true);
    });
  });

  const phaseTabs = [...document.querySelectorAll('.phase-tab')];
  const journeyRows = [...document.querySelectorAll('.journey-row')];
  phaseTabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      const phase = tab.dataset.filter;
      phaseTabs.forEach((item) => {
        const selected = item === tab;
        item.classList.toggle('is-active', selected);
        item.setAttribute('aria-pressed', String(selected));
      });
      journeyRows.forEach((row) =>
        row.classList.toggle('is-hidden', phase !== 'all' && row.dataset.phase !== phase)
      );
    });
  });

  document.querySelectorAll('.journey-toggle').forEach((button) => {
    button.addEventListener('click', () => {
      const row = button.closest('.journey-row');
      if (!row) return;
      const open = !row.classList.contains('is-open');
      row.classList.toggle('is-open', open);
      button.setAttribute('aria-expanded', String(open));
    });
  });
})();
