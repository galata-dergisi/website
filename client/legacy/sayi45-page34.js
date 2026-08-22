setTimeout(function () {
  var playDiv = document.querySelector('.video-play-button');
  var videoMask = document.querySelector('.video-mask');

  playDiv.addEventListener('click', function () {
    document
      .querySelector('.back-video')
      .play();
    playDiv.classList.add('hide');
    videoMask.classList.add('hide');
  });
}, 10);
