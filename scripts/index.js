//Map, data sources, layers and popup variables.
var map, dataSource, clusterDataSource, bubbleLayer, heatMapLayer, popup;

//Parsed aggregated features.
var summaryData = [];

//Lookup table for feature indices in summary data array. A fast way to aggregate features.
var summaryDataIdx = {};

//All timestamps in the data, ordered from oldest to newest.
var timestamps = [];

//Variables to track the selected settings.
var selectedTimeStamp, selectedMetric = 'Confirmed', selectedMapLayer = 'bubbles';

//Time control variable and flags.
var timer, isPaused = true;

//Chart variable.
var chart;

//Regular expression for date columns in metric data sets.
var dateRx = /[0-9]+\&\#x2F;[0-9]+\&\#x2F;[0-9]+/;

//Pie chart legend.
var legend = ['Confirmed', 'Recovered', 'Deaths'];

//The max value used for scaling bubbles. 
var upperLimit = 10000;

//Options for the bubble layer.
var bubbleOptions = {
    Confirmed: {
        color: 'dodgerblue'
    },
    Active: {
        color: 'darkorange'
    },
    Recovered: {
        color: 'limegreen'
    },
    Deaths: {
        color: 'red'
    }
};

//Run the range touch code to make the slider more user friendly with touch.
RangeTouch.setup('#timeSlider');

////////////////////////////////
// Initialization function
///////////////////////////////

function GetMap() {

    //Initialize a map instance.
    map = new atlas.Map('myMap', {
        style: "grayscale_dark",
        //Add your Azure Maps subscription key to the map SDK. Get an Azure Maps key at https://azure.com/maps
        authOptions: {
            authType: 'subscriptionKey',
            subscriptionKey: '<Your Azure Maps Key>'
        }
    });

    //Wait until the map resources are ready.
    map.events.add('ready', function () {
        //Add navigation controls to the map. 
        map.controls.add([
            new atlas.control.ZoomControl(),
            new atlas.control.PitchControl(),
            new atlas.control.CompassControl(),
            new atlas.control.StyleControl({ mapStyles: 'all' })
        ], {
            position: 'top-right'
        });

        //Create a reusable popup for the map.
        popup = new atlas.Popup();
        map.popups.add(popup);

        //Create a data source and add it to the map.
        dataSource = new atlas.source.DataSource();
        map.sources.add(dataSource);

        //Create a data source with clustering enabled. This will be used with pie charts.
        clusterDataSource = new atlas.source.DataSource(null, {
            cluster: true,
            clusterRadius: 100
        });
        map.sources.add(clusterDataSource);

        //Create a heat map layer. Only show features that have confirmed cases. 
        heatMapLayer = new atlas.layer.HeatMapLayer(dataSource, null, {
            opacity: 0.8,
            visible: false,
            filter: ['>', ['get', 'Confirmed'], 0]
        });
        map.layers.add(heatMapLayer, 'labels');

        //Create a bubble layer. 
        bubbleLayer = new atlas.layer.BubbleLayer(dataSource, null, {
            strokeWidth: 0,
            color: 'dodgerblue'
        });
        map.layers.add(bubbleLayer);

        //Add mouse events to the bubble layer. When clicked, show a popup. When hovered, change mouse cursor.
        map.events.add('click', bubbleLayer, featureClicked);
        map.events.add('mousemove', bubbleLayer, hovered);
        map.events.add('mouseout', bubbleLayer, mouseOut);

        //Create an HTML marker layer.
        markerLayer = new HtmlMarkerLayer(clusterDataSource, null, {
            markerRenderCallback: function (id, position, properties) {
                return createPieChartMarker(position, properties);
            },
            clusterRenderCallback: function (id, position, properties) {
                var c = createPieChartMarker(position, properties);

                return c;
            },
            visible: false
        });
        map.layers.add(markerLayer);

        //Create a chart control. 
        chart = new Chart(document.getElementById('chart').getContext('2d'), {
            type: 'horizontalBar',
            backgroundColor: '#343740',
            data: {
                labels: [],
                datasets: [{
                    data: [],
                    backgroundColor: 'dodgerblue'
                }]
            },
            options: {
                maintainAspectRatio: false,
                title: {
                    display: true,
                    fontSize: 14,
                    text: 'Top 10 Confirmed Cases by Province/State',
                    fontColor: 'white'
                },
                legend: {
                    display: false
                },
                scales: {
                    yAxes: [{
                        ticks: {
                            fontSize: 14,
                            fontColor: 'white'
                        }
                    }]
                }
            }
        });

        //Load the different metric data sets.
        loadData('Confirmed').then(x => {
            //Parse the date from the most current time stamp.
            var currentDate = new Date(selectedTimeStamp.replace(/&#x2F;/g, '/'));             

            //Add data copyrights and last updated date.
            document.getElementById('dataLabel').innerHTML = '<br/><br/>Data last updated: ' + currentDate.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }) +
                '<br/><br/>Data © Johns Hopkins University (<a target="_blank" href="https://github.com/CSSEGISandData/COVID-19">GitHub</a>)';

            loadData('Recovered').then(x => {
                loadData('Deaths').then(x => {
                    //Update the chart now that the data is loaded. 
                    updateChart();

                    //Update the time sliders max range and update it to the most current date. 
                    document.getElementById('timeSlider').setAttribute('max', timestamps.length - 1);
                    document.getElementById('timeSlider').value = timestamps.length - 1;

                    //Create an animation loop.
                    timer = new FrameAnimationTimer(function (progress, frameIdx) {
                        document.getElementById('timeSlider').value = frameIdx;
                        timeSliderMoved();
                    }, timestamps.length, timestamps.length * 500, true);

                    //Update the layer options based on the time series. 
                    updateLayers();
                });
            });
        });
    });
}

////////////////////////////////
// Data loading functions
///////////////////////////////

async function loadData(metric) {
    //Featch the time series data from the specified metric.
    var response = await fetch(`https://raw.githubusercontent.com/CSSEGISandData/COVID-19/master/csse_covid_19_data/csse_covid_19_time_series/time_series_19-covid-${metric}.csv`);

    //Read the data as text.
    var data = await response.text();

    //Replace forward slashes with their hex code. The Spatial IO module reads forward slashs as property paths for complex objects. 
    //Replacing these with the hex code keeps the extracted property data as simple 2D property.
    data = data.replace(/\//g, '&#x2F;');

    //Read the data as a spatial CSV using the Spatial IO module.
    var r = await atlas.io.read(data);

    var id, f, i, j, val;

    //Loop through each feature and aggregate the data with features loaded from previous data sets.
    for (i = 0; i < r.features.length; i++) {
        //Create a unique ID for each feature using the Country/Region and Province/State names. 
        id = r.features[i].properties['Country&#x2F;Region'];

        if (r.features[i].properties['Province&#x2F;State']) {
            id += '|' + r.features[i].properties['Province&#x2F;State'];
        }

        //Check the feature index in the lookup table to determine if a feature with the specified ID has already been indexed.
        if (typeof summaryDataIdx[id] !== 'undefined') {
            //If it has, retrieve the feature.
            f = summaryData[summaryDataIdx[id]];
        } else {
            //Create a feature using the geometry, Country/Region and Province/State properties.
            f = new atlas.data.Feature(r.features[i].geometry, {
                'Country&#x2F;Region': r.features[i].properties['Country&#x2F;Region'],
                'Province&#x2F;State': r.features[i].properties['Province&#x2F;State']
            });

            //Use the features index in the array as the lookup value in the index in the lookup table.
            summaryDataIdx[id] = summaryData.length;
            summaryData.push(f);
        }

        //Extract the timestamps from the first row of the first data set.
        if (timestamps.length === 0 && metric === 'Confirmed') {
            var keys = Object.keys(r.features[i].properties);

            for (j = 0; j < keys.length; j++) {
                if (dateRx.test(keys[j])) {
                    //Parse the time series data as a float.
                    val = r.features[i].properties[keys[j]];
                    r.features[i].properties[keys[j]] = (!val || val === '')? 0: parseFloat(val);
                    timestamps.push(keys[j]);
                }
            }

            //Time stamp data in the metric data set is ordered such that the last date is the most current.
            //Capture the most current date in the data set.
            selectedTimeStamp = timestamps[timestamps.length - 1];
        } else {
            //Parse the time series data as a float.
            for (j = 0; j < timestamps.length; j++) {
                if (dateRx.test(timestamps[j])) {
                    val = r.features[i].properties[timestamps[j]];
                    r.features[i].properties[timestamps[j]] = (!val || val === '') ? 0 : parseFloat(val);
                }
            }
        }

        //Capture the metric time-series data.
        f.properties[metric + 'Series'] = r.features[i].properties;

        //When on the last data set, calculate aggregates.
        if (metric === 'Deaths') {
            var prop = summaryData[summaryDataIdx[id]].properties;

            //Calculate the number of Active cases in the series.
            summaryData[summaryDataIdx[id]].properties.ActiveSeries = {};

            for (j = 0; j < timestamps.length; j++) {
                summaryData[summaryDataIdx[id]].properties.ActiveSeries[timestamps[j]] = prop.ConfirmedSeries[timestamps[j]] - prop.RecoveredSeries[timestamps[j]] - prop.DeathsSeries[timestamps[j]];
            }
        }
    }

    //When on last metric data set, generate cluster aggregates and pass the aggregated data into the data sources.
    if (metric === 'Deaths') {
        var clusterAgg = {};

        for (j = 0; j < timestamps.length; j++) {
            //Create cluster aggregates that calculate the totals for each metric time-series.
            clusterAgg['ConfirmedSeries|' + timestamps[j]] = ['+', ['get', timestamps[j], ['get', 'ConfirmedSeries']], 1, 0];
            clusterAgg['RecoveredSeries|' + timestamps[j]] = ['+', ['get', timestamps[j], ['get', 'RecoveredSeries']], 1, 0];
            clusterAgg['DeathsSeries|' + timestamps[j]] = ['+', ['get', timestamps[j], ['get', 'DeathsSeries']], 1, 0];
            clusterAgg['ActiveSeries|' + timestamps[j]] = ['+', ['get', timestamps[j], ['get', 'ActiveSeries']], 1, 0];
        }

        clusterDataSource.setOptions({
            clusterProperties: clusterAgg
        });

        dataSource.setShapes(summaryData);
        clusterDataSource.setShapes(summaryData);
    }
}

////////////////////////////////
// Layer functions
///////////////////////////////

function selectLayer(layer) {
    //If the time series is playing, stop it. 
    if (!isPaused) {
        togglePlayPause();
    }

    //Close the popup if it is open.
    popup.close();

    //Update which map layer and legend is displayed based on the selected layer option.
    selectedMapLayer = layer;
    
    switch (layer) {
        case 'bubbles':
            bubbleLayer.setOptions({ visible: true });
            heatMapLayer.setOptions({ visible: false });
            markerLayer.setOptions({ visible: false });
            document.getElementById('bubbleLegend').style.display = '';
            document.getElementById('heatGradientLegend').style.display = 'none';
            document.getElementById('pieLegend').style.display = 'none';
            break;
        case 'heatmap':
            heatMapLayer.setOptions({ visible: true });
            markerLayer.setOptions({ visible: false });
            bubbleLayer.setOptions({ visible: false });
            document.getElementById('bubbleLegend').style.display = 'none';
            document.getElementById('heatGradientLegend').style.display = '';
            document.getElementById('pieLegend').style.display = 'none';
            break;
        case 'piecharts':
            heatMapLayer.setOptions({ visible: false });
            markerLayer.setOptions({ visible: true });
            bubbleLayer.setOptions({ visible: false });
            document.getElementById('bubbleLegend').style.display = 'none';
            document.getElementById('heatGradientLegend').style.display = 'none';
            document.getElementById('pieLegend').style.display = '';
            break;
    }

    //Update selected layer options.
    updateLayers();

    //Update the chart data and styles.
    updateChart();
}

function updateLayers(metric) {
    //If a metric is specified, update the selected metric variable.
    if (metric) {
        selectedMetric = metric;
    }

    //Update the colors of the bubble layer to align with the selected metric color.
    bubbleLayer.setOptions(bubbleOptions[selectedMetric]);

    //Update the colors of the bubble legend circles to align with the selected metric color.
    var bubbleFillLegend = document.getElementsByClassName('bubbleFill');

    for (var i = 0; i < bubbleFillLegend.length; i++) {
        bubbleFillLegend[i].style.fill = bubbleOptions[selectedMetric].color;
    }

    var series = selectedMetric + 'Series';

    //Update the displayed date.
    document.getElementsByClassName('timeControl-label')[0].innerHTML = selectedTimeStamp;

    //Update bubble layer based on time series and selected time stamp.
    if (selectedMapLayer === 'bubbles') {
        bubbleLayer.setOptions({
            radius: [
                'interpolate',
                ['linear'],
                ['get', selectedTimeStamp, ['get', series]],
                0, 5,
                upperLimit, 40
            ],
            opacity: ['case',
                ['>', ['get', selectedTimeStamp, ['get', series]], 0],
                0.75, 0
            ]
        });
    }

    //Update heat map layer based on time series and selected time stamp.
    if (selectedMapLayer === 'heatmap') {
        heatMapLayer.setOptions({
            radius: [
                'interpolate',
                ['linear'],
                ['get', selectedTimeStamp, ['get', series]],
                0, 5,
                1000, 20
            ],
            weight: [
                'interpolate',
                ['linear'],
                ['get', selectedTimeStamp, ['get', series]],
                1, 0.1,
                1000, 1
            ],
            filter: ['>', ['get', selectedTimeStamp, ['get', series]], 0]
        });
    }

    //If piecharts are displayed, force an update.
    if (selectedMapLayer === 'piecharts') {
        markerLayer.update();
    }

    //Update the chart data.
    updateChart();
}

////////////////////////////////
// Chart updating functions
///////////////////////////////

function updateChart() {
    var series = selectedMetric + 'Series';

    //Get all the features and sort for the current metric by time.
    var features = dataSource.toJson().features.sort(getFeatureSort(selectedTimeStamp, series));

    var totalConfirmed = 0, totalRecovered = 0, totalDeaths = 0;
    var xlabels = [];
    var yvalues = [];

    for (var i = 0, len = features.length; i < len; i++) {
        //Get data for the top 10 features by the selected metric and timestamp.
        if (i < 10) {
            yvalues.push(features[i].properties[series][selectedTimeStamp]);

            if (features[i].properties['Province&#x2F;State']) {
                xlabels.push(features[i].properties['Province&#x2F;State']);
            } else {
                xlabels.push(features[i].properties['Country&#x2F;Region']);
            }
        }

        //Calculate the total metrics across all features.
        totalConfirmed += features[i].properties['ConfirmedSeries'][selectedTimeStamp];
        totalRecovered += features[i].properties['RecoveredSeries'][selectedTimeStamp];
        totalDeaths += features[i].properties['DeathsSeries'][selectedTimeStamp];
    }

    //Calculate the total active. 
    var totalActive = totalConfirmed - totalRecovered - totalDeaths;

    //Update the metric totals that are displayed.
    var space = '<br/>&nbsp;&nbsp;&nbsp;&nbsp;';

    document.getElementById('metricTotals').innerHTML = `<h3>Total</h3>${space}Confirmed: ${totalConfirmed.toLocaleString()}${space}Recovered: ${totalRecovered.toLocaleString()}${space}Deaths: ${totalDeaths.toLocaleString()}${space}Active: ${totalActive.toLocaleString()}`;

    //Update the chart title highlight the selected metric.
    chart.options.title.text = `Top 10 ${selectedMetric} cases by location`;

    //Update aria-label of chart canvas for accessibility.
    document.getElementById('chart').setAttribute('aria-label', `${chart.options.title.text}. Confirmed: ${totalConfirmed}, recovered: ${totalRecovered}, deaths: ${totalDeaths}, active: ${totalActive}`);

    //Update the data in the chart.
    chart.data = {
        labels: xlabels,
        datasets: [{
            data: yvalues,
            backgroundColor: bubbleOptions[selectedMetric].color
        }]
    };
    chart.update();
}

//////////////////////////////
// Pie Chart Marker functions
//////////////////////////////

function createPieChartMarker(position, properties) {
    //Set the max radius to 50. 
    var radius = 50;

    var c, r, d;

    //Get the selected time series data for the marker. 
    if (properties.cluster) {
        c = properties['ConfirmedSeries|' + selectedTimeStamp];
        r = properties['RecoveredSeries|' + selectedTimeStamp];
        d = properties['DeathsSeries|' + selectedTimeStamp];
    } else {
        c = properties['ConfirmedSeries'][selectedTimeStamp];
        r = properties['RecoveredSeries'][selectedTimeStamp];
        d = properties['DeathsSeries'][selectedTimeStamp];
    }

    //Get the selected metric value.
    var m = c;
    switch (selectedMetric) {
        case 'Recovered':
            m = r;
            break;
        case 'Deaths':
            m = d;
            break;
        case 'Active':
            m = c - r - d;
            break;
    }

    //Use the selected metric value to scale the radius of the pie chart.
    if (m < 1000) {
        radius = 25;
    } else if (m < 10000) {
        radius = 40;
    } 

    //Retrieve the pie slice colors. Align with bubble layer colors for the metrics.
    var legendColors = [
        bubbleOptions['Confirmed'].color,
        bubbleOptions['Recovered'].color,
        bubbleOptions['Deaths'].color
    ];

    //Create the pie chart marker. Add a callback for a tooltip.
    var marker = new PieChartMarker({
        position: position,
        values: [c, r, d],
        colors: legendColors,
        radius: radius,
        strokeThickness: 1,
        strokeColor: 'white',
        innerRadius: 0,
        visible: c > 0,
        anchor: 'center'
    }, tooltipCallback);

    //Add mouse/touch events to the markers.
    map.events.add('click', marker, markerClicked);    
    map.events.add('mouseup', marker, markerMouseUp);

    return marker;
}

////////////////////////////////
// Event handlers
///////////////////////////////

function timeSliderMoved() {
    //When the time slider moves, update the selected time stamp. This will be used to filter the data.
    var offset = parseInt(document.getElementById('timeSlider').value);
    selectedTimeStamp = timestamps[offset];

    //Advance the timer so that if the user presses play, it continues from where the slider is.
    timer.setFrameIdx(offset);

    //Update the layer options based on the time series. 
    updateLayers();
}

function hovered() {
    map.getCanvasContainer().style.cursor = 'pointer';
}

function mouseOut() {
    map.getCanvasContainer().style.cursor = 'grab';
}

function featureClicked(e) {
    //When a feature is clicked, show the popup.
    showPopup(e.shapes[0].getCoordinates(), e.shapes[0].getProperties());
}

function markerClicked(e) {
    if (e.target.properties.cluster) {
        //Get the cluster expansion zoom level. This is the zoom level at which the cluster starts to break apart.
        clusterDataSource.getClusterExpansionZoom(e.target.properties.cluster_id).then(function (zoom) {

            //Update the map camera to be centered over the cluster.
            map.setCamera({
                center: e.target.getOptions().position,
                zoom: zoom,
                type: 'ease',
                duration: 200
            });
        });
    } else {
        //Show the popup for the feature.
        showPopup(e.target.getOptions().position, e.target.properties);
    }
}

function markerMouseUp() {
    //When a mouse/touch up event occurs on a pie chart marker, hide the tooltip. 
    PieChartMarker.__hideTooltip();
}

////////////////////////////////
// Popup/Tooltip functions
///////////////////////////////

function showPopup(position, properties) {

    var title = '';

    //Only use province/state in title if valid and not the same value as the country.
    if (properties['Province&#x2F;State'] !== undefined && properties['Province&#x2F;State'] !== properties['Country&#x2F;Region']) {
        title = properties['Province&#x2F;State'] + ', ';
    }

    title += properties['Country&#x2F;Region'];

    popup.setOptions({
        //Format the content of the popup to contain the title, the date the data is for, and table with the metrics.
        content: `<div class="customPopup"><b>${title}</b><br/><table><tr><td><tr><td>Confirmed:</td><td>${properties.ConfirmedSeries[selectedTimeStamp].toLocaleString()}</td></tr><tr><td>Recovered:</td><td>${properties.RecoveredSeries[selectedTimeStamp].toLocaleString()}</td></tr><tr><td>Deaths:</td><td>${properties.DeathsSeries[selectedTimeStamp].toLocaleString()}</td></tr><tr><td>Active:</td><td>${properties.ActiveSeries[selectedTimeStamp].toLocaleString()}</td></tr></table></div>`,

        //Update the position of the popup.
        position: position
    });

    //Open the popup.
    popup.open(map);
}

function tooltipCallback(marker, sliceIdx) {
    //Get the tooltip text for a slice of a pie chart marker.
    return legend[sliceIdx] + '<br/>' + marker.getSliceValue(sliceIdx) + ' (' + marker.getSlicePercentage(sliceIdx) + '%)';
}

////////////////////////////////
// Animation functions
///////////////////////////////

//Toggle button logic for play/pause button.
function togglePlayPause() {
    if (isPaused) {
        timer.play();
        document.getElementById('playPauseBtn').value = ' || ';
    } else {
        timer.pause();
        document.getElementById('playPauseBtn').value = '►';
    }

    isPaused = !isPaused;
}

//Animation timer.
function FrameAnimationTimer(renderFrameCallback, numFrames, duration, loop) {
    var _timerId,
        frameIdx = 0,
        _isPaused = false;

    duration = (duration && duration > 0) ? duration : 1000;

    delay = duration / (numFrames - 1);

    this.play = function () {
        if (renderFrameCallback) {
            if (_timerId) {
                _isPaused = false;
            } else {
                _timerId = setInterval(function () {
                    if (!_isPaused) {
                        var progress = (frameIdx * delay) / duration;

                        renderFrameCallback(progress, frameIdx);

                        if (progress >= 1) {
                            if (loop) {
                                frameIdx = 0;
                            } else {
                                reset();
                            }
                        }

                        frameIdx++;
                    }
                }, delay);
            }
        }
    };

    this.pause = function () {
        _isPaused = true;
    };

    this.stop = function () {
        reset();
    };

    this.setFrameIdx = function (idx) {
        frameIdx = idx;
    };

    function reset() {
        if (_timerId !== null) {
            clearInterval(_timerId);
        }

        frameIdx = 0;
        _isPaused = false;
    }
}

////////////////////////////////
// Misc functions
///////////////////////////////

//Sorts features for a specified series, by date. 
function getFeatureSort(date, series) {
    return function (a, b) {
        return b.properties[series][date] - a.properties[series][date];
    };
}